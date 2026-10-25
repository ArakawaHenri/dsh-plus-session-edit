import { parseRequest } from '../remote.js';
import { fail } from './errors.js';
import { HostAdapter } from './host-adapter.js';
import { historyUpdatedFailure } from './rewrite.js';
import {
  continuationPolicy,
  isAttachmentBlock,
  isHuman,
  isSupportedContent,
  planOperation,
  textOf,
} from './plan.js';

const SETUP_EVENTS = new Set([
  'session/end-seed',
  'session/title',
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'agent-preset/selected',
  'working-directory/change',
  'plan/mode',
  'model/selection',
]);

class SerialQueue {
  #tails = new Map();
  #closed = false;

  run(key, work) {
    if (this.#closed) return Promise.reject(new Error('Session Edit is closing.'));
    const result = (this.#tails.get(key) ?? Promise.resolve()).then(work);
    const tail = result.then(() => {}, () => {});
    this.#tails.set(key, tail);
    tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  async close() {
    this.#closed = true;
    await Promise.all([...this.#tails.values()]);
  }
}

function inspectMessage(event, snapshot) {
  if (!event || !isHuman(event)) {
    fail('message-not-editable', 'Select a recorded human input message.');
  }
  const text = textOf(event.data);
  const supported = isSupportedContent(event.data);
  const hasAttachments =
    Array.isArray(event.data?.content) && event.data.content.some(isAttachmentBlock);
  const editable =
    supported &&
    (Boolean(text.trim()) || hasAttachments) &&
    text.length <= 131072 &&
    snapshot.ordinary &&
    !snapshot.archived;
  return {
    eventSeq: event.seq,
    messageId: event.data.id,
    text,
    time: event.time,
    editable,
    ...(editable
      ? {}
      : {
          reason: !snapshot.ordinary
            ? 'owned-session'
            : snapshot.archived
              ? 'archived'
              : !supported
                ? 'message-not-editable'
                : 'message-too-large',
        }),
  };
}

export class SessionEditEngine {
  constructor(ctx, dependencies = {}) {
    this.ctx = ctx;
    this.host = dependencies.host ?? new HostAdapter(ctx);
    this.now = dependencies.now ?? Date.now;
    this.sessions = new SerialQueue();
    this.closed = false;
  }

  options() {
    return {
      defaultModel: this.host.defaultModel(),
      projections: this.ctx.sessions?.messageProjections ?? [],
    };
  }

  assertOpen() {
    if (this.closed) fail('closing', 'Session Edit is being unloaded.');
  }

  async inspect(input) {
    this.assertOpen();
    const request = parseRequest('inspect', input);
    const snapshot = await this.host.snapshot(request.sessionId);
    const message =
      request.eventSeq !== undefined
        ? inspectMessage(
            snapshot.events[request.eventSeq]?.seq === request.eventSeq
              ? snapshot.events[request.eventSeq]
              : undefined,
            snapshot,
          )
        : undefined;

    const continuation =
      !snapshot.ordinary || snapshot.archived || snapshot.status === 'running'
        ? { available: false }
        : continuationPolicy(snapshot.events, this.options());

    return {
      sessionId: snapshot.header.id,
      status: snapshot.status,
      archived: snapshot.archived,
      ordinary: snapshot.ordinary,
      headSeq: snapshot.cursor,
      ...(message ? { message } : {}),
      continuation,
    };
  }

  async execute(input) {
    this.assertOpen();
    const command = parseRequest('execute', input);
    const options = this.options();
    return this.sessions.run(command.sessionId, async () => {
      await this.host.requireCurrentFormat(command.sessionId);
      const snapshot = await this.host.snapshot(command.sessionId);
      const plan = planOperation(command, snapshot, options);

      if (command.action === 'continue') {
        const agent = await this.host.resolve(plan.sessionId);
        const activated = await this.host.snapshot(plan.sessionId);
        if (
          activated.events
            .slice(plan.headSeq + 1)
            .some(event => !SETUP_EVENTS.has(event.type))
        ) {
          fail('session-changed', 'The session changed during activation.');
        }
        planOperation(command, activated, options);
        this.host.continueFromHistory(agent, agent.session.seq - 1);
        await this.host.flush(agent);
        return { sourceSessionId: plan.sessionId };
      }

      const rewritten = await this.host.rewrite(snapshot, plan, this.now());
      try {
        const agent = await this.host.resolve(plan.sessionId);
        this.host.continueFromHistory(agent, agent.session.seq - 1);
        await this.host.syncTitle?.(agent, rewritten?.editedSeq);
        await this.host.flush(agent);
      } catch (error) {
        throw historyUpdatedFailure(error);
      }
      return { sourceSessionId: plan.sessionId, historyUpdated: true };
    });
  }

  async close() {
    this.closed = true;
    await this.sessions.close();
  }
}
