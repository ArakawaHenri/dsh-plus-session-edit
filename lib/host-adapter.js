import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { rewriteHistory } from './rewrite.js';
import { fail } from './errors.js';

export class HostAdapter {
  constructor(ctx) {
    this.ctx = ctx;
  }

  defaultModel() {
    return this.ctx.get?.('agentDefaultModel')?.currentSelection?.() ?? {};
  }

  async snapshot(sessionId) {
    const observation = await this.ctx.sessionQuery.observeSession(sessionId);
    try {
      const { events, header } = observation;
      const agent = this.ctx.agents.get(sessionId);
      const liveRoot = !agent || this.ctx.agents.roots().some(root => root.id === agent.id);
      const ownDelegation = events.some(
        event => event.type === 'subagent/descriptor' && event.seq >= observation.inheritedEventCount,
      );
      const ordinary = header.origin !== 'subagent' && liveRoot && !ownDelegation;

      return {
        header,
        events,
        inheritedEventCount: observation.inheritedEventCount,
        cursor: observation.cursor ?? events.at(-1)?.seq ?? -1,
        status: agent?.status ?? 'cold',
        ordinary,
        archived: this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId),
      };
    } finally {
      observation[Symbol.dispose]();
    }
  }

  async requireCurrentFormat(sessionId) {
    const stat = await this.ctx.sessionPersistence.stat(sessionId);
    if (stat?.formatStatus === 'migration-required') {
      fail('migration-required', 'Open the source session in DSH to complete migration first.');
    }
    if (stat?.formatStatus && stat.formatStatus !== 'current') {
      fail('unsupported-format', 'This session format is not supported.');
    }
  }

  async resolve(sessionId) {
    const result = await this.ctx.sessionController.resolveAgent(sessionId);
    if (result?.error) throw result.error;
    if (!result?.agent) fail('host-error', 'The host could not activate this session.');
    return result.agent;
  }

  rewrite(snapshot, plan, now) {
    return rewriteHistory(this.ctx, snapshot, plan, now);
  }

  continueFromHistory(agent, expectedSeq) {
    this.assertIdle(agent);
    if (expectedSeq !== undefined && agent.session.seq - 1 !== expectedSeq) {
      fail('session-changed', 'The session changed before continuation.');
    }
    if (
      typeof agent.wakeDriver !== 'function' ||
      typeof agent.ctx?.on !== 'function' ||
      typeof agent.whenIdle !== 'function'
    ) {
      fail('unsupported-runtime', 'The active agent runtime does not support history continuation.');
    }
    const expectedTurn = (agent.phase?.lastTurn ?? 0) + 1;
    const wakeMarker = createUserMessage({
      content: [],
      source: { kind: 'runtime-context' },
    });
    const dispose = agent.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent && payload.agent !== agent) return next();
      dispose();
      const decision = await next();
      if (
        payload.turn === expectedTurn &&
        payload.step === 1 &&
        decision.kind === 'enter' &&
        decision.messages.length === 0
      ) {
        return { ...decision, messages: [wakeMarker] };
      }
      return decision;
    });
    try {
      agent.wakeDriver(false);
    } finally {
      agent.whenIdle().then(dispose, dispose);
    }
  }

  assertIdle(agent) {
    if (
      this.ctx.agents.get(agent.id) !== agent ||
      agent.status !== 'idle' ||
      (agent.phase && agent.phase.kind !== 'idle')
    ) {
      fail('source-running', 'The session started other work before submission.');
    }
    if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
      fail('queue-pending', 'Handle the pending queue before submitting this operation.');
    }
  }

  flush(agent) {
    return this.ctx.sessions.flush(agent.session);
  }

  async syncTitle(agent, editedSeq) {
    const sessionTitle = this.ctx.get?.('sessionTitle');
    if (!sessionTitle || !Number.isSafeInteger(editedSeq)) return;
    const editedEvent = agent.session.snapshotEvents()[editedSeq];
    if (!editedEvent) return;
    sessionTitle.onUserMessage?.(agent.session, editedEvent);
    await sessionTitle.ensureFallback?.(agent.session)?.catch(() => {});
  }
}
