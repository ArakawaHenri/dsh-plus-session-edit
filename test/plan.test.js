import test from 'node:test';
import assert from 'node:assert/strict';
import {
  continuationPolicy,
  foldInbox,
  modelOf,
  rewriteSeed,
  planOperation,
  surfaceEvents,
} from '../lib/plan.js';

const human = (text, id = 'u') => ({
  id,
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
});

function log() {
  const events = [];
  const push = (type, data, surfaceOp) => {
    const e = {
      type,
      data,
      seq: events.length,
      time: 1,
      ...(surfaceOp ? { surfaceOp } : {}),
    };
    events.push(e);
    return e;
  };
  return { events, push };
}

function fixture() {
  const { events, push } = log();
  const message = human('original');
  push('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [message, human('queued', 'q')],
  });
  push('turn/start', { turn: 1 });
  push('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  push('step/start', { turn: 1, step: 1 });
  const target = push('user/message', message, 'append');
  push('request/header', {
    header: { config: { provider: 'fixture', model: 'm' } },
    reason: 'initial',
  });
  push(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: {
        id: 'a',
        role: 'assistant',
        source: {
          kind: 'model',
          provider: 'fixture',
          model: 'm',
          replayState: {
            response: { kind: 'pi-ai', api: 'openai-responses', stopReason: 'stop' },
          },
        },
        content: [{ type: 'text', text: 'partial' }],
      },
    },
    'append',
  );
  push('step/end', { turn: 1, step: 1 });
  push('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
  const snapshot = {
    events,
    header: { id: 'source', version: 4, cwd: '/fixture', isSeeded: false, createdAt: 1 },
    workspaceId: 'workspace',
    ordinary: true,
    archived: false,
    status: 'idle',
  };
  const request = {
    sessionId: 'source',
    action: 'retry',
    eventSeq: target.seq,
    messageId: target.data.id,
  };
  const clearQueue = () =>
    push('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      removedCount: 1,
      inserted: [],
      outcome: 'canceled',
    });
  return { events, push, target, snapshot, request, clearQueue };
}

test('history rewrite replaces the target, drops its suffix and cancels retained queues', () => {
  const { events, target, snapshot, request } = fixture();
  const before = JSON.stringify(events);
  const plan = planOperation({ ...request, action: 'edit', replacementText: 'edited' }, snapshot);
  const { events: seed } = rewriteSeed(snapshot, plan, human('edited', 'edited-id'), 10);
  assert.deepEqual(seed.slice(0, target.seq), events.slice(0, target.seq));
  assert.equal(seed[target.seq].data.content[0].text, 'edited');
  assert.equal(seed.some(event => event.type === 'assistant/message'), false);
  assert.deepEqual(foldInbox(seed), { 'next-turn': [], 'next-step': [] });
  assert.equal(continuationPolicy(seed).available, true);
  assert.equal(JSON.stringify(events), before);
});

test('seq-zero history remains contiguous and resumable after editing', () => {
  const events = [{ type: 'user/message', seq: 0, time: 1, data: human('first'), surfaceOp: 'append' }];
  const snapshot = { events, header: { id: 'source', isSeeded: false }, inheritedEventCount: 0 };
  const seed = rewriteSeed(snapshot, { eventSeq: 0 }, human('edited', 'new-id'), 10);
  assert.equal(seed.inheritedEventCount, 0);
  assert.deepEqual(seed.events.map(event => event.seq), [0, 1, 2]);
  assert.equal(seed.events[0].data.content[0].text, 'edited');
  assert.equal(continuationPolicy(seed.events).available, true);
});

test('plan verifies message identity, preserves image and file attachments on edit/retry, and rejects unsupported blocks', () => {
  const { snapshot, target, request } = fixture();
  const imageBlock = {
    type: 'image',
    attachment: {
      attachmentId: 'sha256:1111111111111111',
      mediaType: 'image/png',
      bytes: 128,
      width: 16,
      height: 16,
      name: 'diagram.png',
    },
  };
  const fileBlock = {
    type: 'file',
    attachment: {
      attachmentId: 'sha256:2222222222222222',
      name: 'notes.txt',
      bytes: 42,
    },
  };
  target.data.content = [imageBlock, ...target.data.content, { type: 'text', text: ' second block' }, fileBlock];
  const retryPlan = planOperation(request, snapshot);
  assert.deepEqual(retryPlan.content, target.data.content);
  assert.notEqual(retryPlan.content, target.data.content);

  const editPlan = planOperation(
    { ...request, action: 'edit', replacementText: 'updated prompt' },
    snapshot,
  );
  assert.deepEqual(editPlan.content, [
    imageBlock,
    { type: 'text', text: 'updated prompt' },
    fileBlock,
  ]);

  // Attachment-only messages can be retried as-is or given text via edit.
  target.data.content = [imageBlock];
  assert.deepEqual(planOperation(request, snapshot).content, [imageBlock]);
  assert.deepEqual(
    planOperation({ ...request, action: 'edit', replacementText: 'added caption' }, snapshot).content,
    [imageBlock, { type: 'text', text: 'added caption' }],
  );

  assert.throws(
    () => planOperation({ ...request, messageId: 'another-message' }, snapshot),
    error => error.code === 'session-edit/session-changed',
  );
  assert.throws(
    () => planOperation({ ...request, messageId: undefined }, snapshot),
    error => error.code === 'session-edit/session-changed',
  );
  target.data.source.kind = 'runtime-context';
  assert.throws(() => planOperation(request, snapshot), /human input/);
  target.data.source.kind = 'user';
  target.data.content.push({ type: 'image', image: 'fixture' });
  assert.throws(
    () => planOperation(request, snapshot),
    error => error.code === 'session-edit/message-not-editable',
  );
});

test('continuation requires an unfinished turn and no pending queue', () => {
  const { events, clearQueue } = fixture();
  assert.equal(continuationPolicy(events).available, false);
  clearQueue();
  assert.equal(continuationPolicy(events).available, true);
  events.findLast(e => e.type === 'turn/end').data.reason.reason.kind = 'disposed';
  assert.equal(continuationPolicy(events).available, false);
});

test('unknown assistant-tail models allow direct continuation', () => {
  const { events, snapshot, clearQueue } = fixture();
  clearQueue();
  delete events.find(e => e.type === 'assistant/message').data.message.source.replayState;
  const policy = continuationPolicy(events);
  assert.equal(policy.available, true);
  const plan = planOperation({ action: 'continue' }, snapshot);
  assert.deepEqual(plan, {
    sessionId: 'source',
    action: 'continue',
    headSeq: events.at(-1).seq,
  });
});

for (const reason of [{ kind: 'error', error: 'offline rejection' }, { kind: 'max-tokens' }]) {
  test(`a ${reason.kind} turn remains eligible for an explicit continuation`, () => {
    const { events, snapshot, clearQueue } = fixture();
    clearQueue();
    events.findLast(e => e.type === 'turn/end').data.reason = reason;
    assert.equal(continuationPolicy(events).available, true);
    assert.deepEqual(planOperation({ action: 'continue' }, snapshot), {
      sessionId: 'source',
      action: 'continue',
      headSeq: events.at(-1).seq,
    });
  });
}

for (const stopReason of ['aborted', 'error']) {
  test(`known ${stopReason} replay metadata discarded by the adapter blocks no-message continuation`, () => {
    const { events, snapshot, clearQueue } = fixture();
    clearQueue();
    events.find(e => e.type === 'assistant/message').data.message.source.replayState.response.stopReason =
      stopReason;
    const policy = continuationPolicy(events);
    assert.equal(policy.available, false);
    assert.throws(
      () => planOperation({ action: 'continue' }, snapshot),
      error => error.code === 'session-edit/continuation-unsupported',
    );
  });
}

test('an unpaired tool call blocks direct continuation', () => {
  const { events, clearQueue } = fixture();
  clearQueue();
  events
    .find(e => e.type === 'assistant/message')
    .data.message.content.push({ type: 'tool-call', id: 'call-1', name: 'fixture', input: {} });
  const policy = continuationPolicy(events);
  assert.equal(policy.available, false);
});

test('surface replacement position does not make an older replacement the conversation tail', () => {
  const { events, push } = log();
  push('user/message', human('first', 'u1'), 'append');
  push('user/message', human('last', 'u2'), 'append');
  push('user/message', human('replace-first', 'u3'), {
    op: 'replace',
    startSeq: 0,
    endSeq: 0,
  });
  events.at(-1).sourceEventSeqs = [0];
  assert.equal(surfaceEvents(events).at(-1).data.content[0].text, 'last');
});

test('regeneration retains the current model selection', () => {
  const { events, push } = log();
  push('request/header', { header: { config: { provider: 'first', model: 'old' } } });
  push('model/selection', { provider: 'selected', model: 'at-cut', reasoningEffort: 'high' });
  const target = push('user/message', human('retry me'), 'append');
  push('request/header', { header: { config: { provider: 'selected', model: 'at-cut' } } });
  push('model/selection', { provider: 'later', model: 'current-model' });
  const snapshot = {
    events,
    header: { id: 'source', cwd: '/fixture' },
    ordinary: true,
    archived: false,
    status: 'idle',
  };
  const plan = planOperation(
    { action: 'retry', eventSeq: target.seq, messageId: target.data.id },
    snapshot,
    { defaultModel: { provider: 'default', model: 'fallback' } },
  );
  assert.deepEqual(plan.modelSelection, {
    provider: 'later',
    model: 'current-model',
  });
});

test('invalid inbox splices fail closed', () => {
  assert.throws(
    () =>
      foldInbox([
        { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 10, inserted: [] } },
      ]),
    /invalid inbox/,
  );
});

test('trailing developer or system messages on the surface do not obscure the conversation tail', () => {
  const { events, push, clearQueue } = fixture();
  clearQueue();
  events.findLast(event => event.type === 'turn/end').data.reason = {
    kind: 'error',
    error: 'network failure',
  };
  push(
    'developer/message',
    {
      turn: 1,
      step: 1,
      message: {
        id: 'dev-1',
        role: 'developer',
        source: { kind: 'tool-registry' },
        content: [{ type: 'text', text: 'context notice' }],
      },
    },
    'append',
  );
  const policy = continuationPolicy(events);
  assert.equal(policy.available, true);
});

test('a second-step inbox claim aborted before message admission is detected as not resumable', () => {
  const { events, push, clearQueue } = fixture();
  clearQueue();
  push('agent/inbox/spliced', {
    target: 'next-step',
    start: 0,
    inserted: [human('steering input', 's1')],
  });
  push('agent/inbox/spliced', {
    target: 'next-step',
    start: 0,
    removedCount: 1,
    inserted: [],
  });
  const policy = continuationPolicy(events);
  assert.equal(policy.available, false);
});

test('adapter-defaulted reasoningEffort is not turned into an explicit model selection', () => {
  const { events, push } = log();
  const target = push('user/message', human('retry me'), 'append');
  push('request/header', {
    header: {
      config: { provider: 'offline', model: 'stub', reasoningEffort: 'medium' },
      adapterDefaults: { reasoningEffort: true },
    },
  });
  const snapshot = {
    events,
    header: { id: 'source', cwd: '/fixture' },
    ordinary: true,
    archived: false,
    status: 'idle',
  };
  const plan = planOperation(
    { action: 'retry', eventSeq: target.seq, messageId: target.data.id },
    snapshot,
  );
  assert.deepEqual(plan.modelSelection, { provider: 'offline', model: 'stub' });
});

test('a pending model selection is consumed only by a matching request, including effort', () => {
  const { events, push } = log();
  const selected = { provider: 'offline', model: 'selected', reasoningEffort: 'high' };
  push('model/selection', selected);
  push('request/header', { header: { config: { ...selected, reasoningEffort: 'low' } } });
  assert.deepEqual(modelOf(events), selected);
  push('request/header', { header: { config: selected } });
  const later = { provider: 'offline', model: 'later' };
  push('request/header', {
    header: { config: { ...later, reasoningEffort: 'medium' }, adapterDefaults: { reasoningEffort: true } },
  });
  assert.deepEqual(modelOf(events), later);
});

test('rewriteSeed drops stale auto-titles on edit, preserves valid auto-titles on retry, and keeps plan/mode', () => {
  const { events, push } = log();
  const first = push('user/message', human('first prompt', 'u1'), 'append');
  push('session/title', {
    title: 'first prompt',
    messageSeqs: [first.seq],
    source: { kind: 'fallback' },
  });
  push('plan/mode', { enabled: true });
  const snapshot = {
    events,
    header: { id: 'source', cwd: '/fixture', isSeeded: true },
    inheritedEventCount: 1,
    ordinary: true,
    archived: false,
    status: 'idle',
  };

  const editPlan = planOperation(
    { action: 'edit', eventSeq: first.seq, messageId: first.data.id, replacementText: 'new prompt' },
    snapshot,
  );
  const editedSeed = rewriteSeed(snapshot, editPlan, human('new prompt', 'u1-edit'), 10);
  assert.equal(
    editedSeed.events.some(event => event.type === 'session/title'),
    false,
  );
  assert.deepEqual(
    editedSeed.events.findLast(event => event.type === 'plan/mode')?.data,
    { enabled: true },
  );

  const retryPlan = planOperation(
    { action: 'retry', eventSeq: first.seq, messageId: first.data.id },
    snapshot,
  );
  const retriedSeed = rewriteSeed(snapshot, retryPlan, human('first prompt', 'u1-retry'), 10);
  assert.deepEqual(retriedSeed.events.findLast(event => event.type === 'session/title')?.data, {
    title: 'first prompt',
    messageSeqs: [retriedSeed.editedSeq],
    source: { kind: 'fallback' },
  });
});
