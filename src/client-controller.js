// Self-contained so the ModuleLoader build can inline it without Node modules.
export function createClientController(options) {
  const { rpc, navigate, reloadSession } = options;
  const listeners = new Set();
  const drafts = new Map();
  const reads = new Map();
  const inFlight = new Map();
  let disposed = false;
  let revision = 0;
  let sequence = 0;
  let panelEpoch = 0;
  let snapshot = { revision, panel: null, sessions: {}, notice: null };

  function publish(patch) {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch, revision: ++revision };
    for (const listener of listeners) listener();
  }

  function updatePanel(patch, epoch = panelEpoch) {
    if (!disposed && epoch === panelEpoch && snapshot.panel) {
      publish({ panel: { ...snapshot.panel, ...patch } });
    }
  }

  const errorOf = error => ({
    code: typeof error?.code === 'string' ? error.code : 'session-edit/transport',
    message: typeof error?.message === 'string' ? error.message : String(error || 'Request failed'),
    ...(error?.details ? { details: error.details } : {}),
  });

  async function call(method, request) {
    let reply;
    try {
      reply = await rpc[method](request);
    } catch (error) {
      if (error?.name === 'RemoteError' || error?.rpcError) {
        throw errorOf(error.rpcError || error);
      }
      throw errorOf(error);
    }
    if (!reply || typeof reply.ok !== 'boolean') {
      throw { code: 'session-edit/transport', message: 'Invalid RPC response' };
    }
    if (!reply.ok) throw errorOf(reply.error);
    return reply.value;
  }

  const actionKey = (sessionId, action, target) =>
    JSON.stringify([sessionId, action, action === 'continue' ? null : target]);
  const draftKey = (sessionId, eventSeq, messageId) => JSON.stringify([sessionId, eventSeq, messageId]);

  function oneShot(key, work) {
    if (inFlight.has(key)) return inFlight.get(key);
    const task = Promise.resolve()
      .then(work)
      .finally(() => {
        inFlight.delete(key);
        publish({});
      });
    inFlight.set(key, task);
    publish({});
    return task;
  }

  function newPanel(sessionId, properties) {
    ++panelEpoch;
    publish({
      panel: {
        sessionId,
        busy: false,
        loading: false,
        error: null,
        ...properties,
      },
    });
    return panelEpoch;
  }

  function close() {
    ++panelEpoch;
    publish({ panel: null });
  }

  async function openResult(result, guardEpoch = panelEpoch) {
    const id = result?.sourceSessionId;
    if (!id) return;
    if (guardEpoch !== panelEpoch) {
      // Panel churn since this action started. A foreign panel must never be
      // closed or navigated under; a user-closed panel means lost interest.
      if (snapshot.panel) {
        publish({
          notice: {
            code: 'session-edit/navigation-failed',
            message: 'A dialog is open',
            sessionId: id,
          },
        });
      }
      return;
    }
    if (snapshot.panel) close();
    const navigationEpoch = panelEpoch;
    try {
      if (result.historyUpdated) {
        await reloadSession?.(id);
        await loadSession(id, true);
      }
      if (navigationEpoch !== panelEpoch || disposed) return;
      await navigate(id);
    } catch (error) {
      publish({
        notice: {
          code: result.historyUpdated ? 'session-edit/refresh-failed' : 'session-edit/navigation-failed',
          message: errorOf(error).message,
          sessionId: id,
          historyUpdated: result.historyUpdated,
        },
      });
    }
  }

  const MAX_CACHED_SESSIONS = 32;

  function setSessionEntry(sessionId, entry) {
    const next = { ...snapshot.sessions, [sessionId]: entry };
    const keys = Object.keys(next);
    if (keys.length > MAX_CACHED_SESSIONS) {
      for (const key of keys) {
        if (key !== sessionId && !next[key]?.loading) {
          delete next[key];
          if (Object.keys(next).length <= MAX_CACHED_SESSIONS) break;
        }
      }
    }
    publish({ sessions: next });
  }

  async function loadSession(sessionId, force = false) {
    if (disposed) return;
    if (!force && reads.has(sessionId)) return reads.get(sessionId);
    const loadId = ++sequence;
    const current = snapshot.sessions[sessionId];
    setSessionEntry(sessionId, { ...current, loading: true, loadId });
    const task = (async () => {
      try {
        const value = await call('inspect', { sessionId });
        if (!disposed && snapshot.sessions[sessionId]?.loadId === loadId) {
          setSessionEntry(sessionId, { value, loading: false, loadId });
        }
        return value;
      } catch (error) {
        if (!disposed && snapshot.sessions[sessionId]?.loadId === loadId) {
          setSessionEntry(sessionId, { ...current, loading: false, loadId });
        }
        throw error;
      } finally {
        if (reads.get(sessionId) === task) reads.delete(sessionId);
      }
    })();
    reads.set(sessionId, task);
    return task;
  }

  async function resolveTarget(target) {
    if (target.messageId && target.editable !== false) return target;
    const value = await call('inspect', {
      sessionId: target.sessionId,
      eventSeq: target.eventSeq,
    });
    const message = value.message;
    if (message && (
      (target.text !== undefined && target.text !== message.text) ||
      (target.time !== undefined && target.time !== message.time)
    )) {
      throw { code: 'session-edit/session-changed', message: 'The displayed message changed. Reload the conversation.' };
    }
    if (!message?.messageId || !message.editable) {
      throw {
        code: `session-edit/${message?.reason || 'message-not-editable'}`,
        message: message?.reason || 'Select an editable user message',
      };
    }
    return { ...target, ...message };
  }

  async function openEdit(target) {
    const key = draftKey(target.sessionId, target.eventSeq, target.messageId);
    const epoch = newPanel(target.sessionId, {
      eventSeq: target.eventSeq,
      text: drafts.get(key) ?? target.text ?? '',
      loading: true,
    });
    try {
      const message = await resolveTarget(target);
      updatePanel(
        {
          messageId: message.messageId,
          text: drafts.get(draftKey(target.sessionId, target.eventSeq, message.messageId)) ?? message.text,
          loading: false,
        },
        epoch,
      );
    } catch (error) {
      updatePanel({ loading: false, error: errorOf(error) }, epoch);
    }
  }

  function setText(text) {
    const current = snapshot.panel;
    if (!current || current.busy || current.loading) return;
    drafts.set(draftKey(current.sessionId, current.eventSeq, current.messageId), text);
    updatePanel({ text, error: null });
  }

  function submitEdit() {
    const current = snapshot.panel;
    if (
      !current ||
      current.busy ||
      current.loading ||
      !current.messageId ||
      !current.text?.trim()
    ) {
      return;
    }
    const key = actionKey(current.sessionId, 'edit', current.eventSeq);
    if (inFlight.has(key)) return inFlight.get(key);
    const epoch = panelEpoch;
    updatePanel({ busy: true, error: null });
    return oneShot(key, async () => {
      try {
        const result = await call('execute', {
          sessionId: current.sessionId,
          action: 'edit',
          eventSeq: current.eventSeq,
          messageId: current.messageId,
          replacementText: current.text,
        });
        drafts.delete(draftKey(current.sessionId, current.eventSeq, current.messageId));
        if (disposed) return;
        await openResult(result, epoch);
      } catch (error) {
        if (!await reportSavedFailure(current.sessionId, epoch, error)) {
          updatePanel({ busy: false, error: errorOf(error) }, epoch);
        }
      }
    });
  }

  async function reportSavedFailure(sessionId, epoch, error) {
    if (!error?.details?.historyUpdated) return false;
    if (disposed) return true;
    if (epoch === panelEpoch && snapshot.panel?.sessionId === sessionId) close();
    await reloadSession?.(sessionId).catch(() => {});
    await loadSession(sessionId, true).catch(() => {});
    publish({ notice: { ...errorOf(error), sessionId, historyUpdated: true } });
    return true;
  }

  function retryMessage(target) {
    return oneShot(actionKey(target.sessionId, 'retry', target.eventSeq), async () => {
      const epoch = panelEpoch;
      try {
        const message = await resolveTarget(target);
        const result = await call('execute', {
          sessionId: target.sessionId,
          action: 'retry',
          eventSeq: message.eventSeq,
          messageId: message.messageId,
        });
        if (disposed) return;
        await openResult(result, epoch);
      } catch (error) {
        if (!await reportSavedFailure(target.sessionId, epoch, error) && !disposed) {
          publish({ notice: errorOf(error) });
        }
      }
    });
  }

  function continueSession(sessionId) {
    return oneShot(actionKey(sessionId, 'continue'), async () => {
      publish({ notice: null });
      try {
        const cached = snapshot.sessions[sessionId]?.value;
        const facts = cached ?? (await loadSession(sessionId, true));
        if (!facts) return;
        if (!facts.continuation.available) {
          throw {
            code: 'session-edit/continuation-unsupported',
            message: 'Continuation unavailable',
          };
        }
        await call('execute', {
          sessionId,
          action: 'continue',
        });
        if (disposed) return;
        // The composer already belongs to this session. Refresh admission facts
        // without navigating, moving focus, or closing an inline editor.
        await loadSession(sessionId, true).catch(() => {});
      } catch (error) {
        publish({ notice: errorOf(error) });
      }
    });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadSession,
    openEdit,
    retryMessage,
    continueSession,
    setText,
    submitEdit,
    openResult,
    reportRefreshError(sessionId, error) {
      publish({ notice: { ...errorOf(error), code: 'session-edit/refresh-failed', sessionId, historyUpdated: true } });
    },
    close,
    isBusy: (sessionId, action, target) => inFlight.has(actionKey(sessionId, action, target)),
    clearNotice() {
      publish({ notice: null });
    },
    dispose() {
      disposed = true;
      ++panelEpoch;
      listeners.clear();
      reads.clear();
      drafts.clear();
    },
  };
}
