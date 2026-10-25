// DSH 0.2.1-rc.2 treats an ordinary Session removal as permanent and merges
// projections with higher-seq-wins. A same-ID history rewrite needs a new
// baseline while keeping the retained binding, editor draft and UI subscriptions.
export function createSessionReloader(sessions) {
  const pending = new Map();
  return function reload(sessionId, summary) {
    const existing = pending.get(sessionId);
    if (existing) {
      // A second lifecycle can finish while the first baseline is loading.
      if (summary) { existing.summary = summary; existing.changed = true; }
      return existing.promise;
    }
    const entry = { summary, changed: false };
    entry.promise = Promise.resolve().then(async () => {
      do {
        entry.changed = false;
        const session = sessions.binding(sessionId)?.session;
        const manager = sessions.manager;
        const projections = session?.projections ?? manager?.projectionStores?.get(sessionId);
        if (!manager?.projectionStores || (session && typeof session.resync !== 'function') ||
          (projections && typeof projections.clear !== 'function')) {
          throw new Error('This DSH client cannot reload edited session history.');
        }
        manager.projectionInflight.get(sessionId)?.controller.abort();
        manager.projectionInflight.delete(sessionId);
        manager.projectionLoads.delete(sessionId);
        projections?.clear();
        if (session) {
          // Native removal can drop the manager's store; retain the faces to which
          // this Session and the conversation's hooks already subscribe.
          manager.projectionStores.set(sessionId, projections);
          session.removed = false;
          session.promptError = null;
          session.lastAgentError = null;
        }
        if (entry.summary) manager.handleSessionAdded(entry.summary);
        if (session) {
          await session.resync();
          if (session.getSnapshot().openState === 'error') throw session.getSnapshot().openError;
        }
        // A second rewrite can arrive while the list refresh is still in flight.
        if (!entry.changed) await sessions.refresh();
      } while (entry.changed);
    }).finally(() => pending.delete(sessionId));
    pending.set(sessionId, entry);
    return entry.promise;
  };
}
