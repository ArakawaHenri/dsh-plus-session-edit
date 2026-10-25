import test from 'node:test';
import assert from 'node:assert/strict';
import { defineTool } from '@deepseek-ai/dsh-tools';
import SessionTitleService from '@deepseek-ai/dsh-session-title';
import { createRuntime, chunks, code, human, text, userEvents } from './helpers/runtime.js';
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork';
import { z } from 'zod';

const options = { timeout: 15_000 };

const editCommand = (agent, target, action = 'retry', replacementText) => ({
  sessionId: agent.id,
  action,
  eventSeq: target.seq,
  messageId: target.data.id,
  ...(action === 'edit' ? { replacementText } : {}),
});

for (const compression of ['none', 'zstd']) {
  for (const action of ['edit', 'retry']) {
    test(`real ${action} rewrites the same ${compression} session and regenerates only its suffix`, options, async t => {
      const f = await createRuntime(t, {}, { compression, cache: true });
      const source = await f.createSource();
      await f.send(source.agent, 'Earlier input.');
      const original = human('Original input.');
      const targetInput = { ...original, content: [...original.content, { type: 'text', text: ' Second block.' }] };
      await f.send(source.agent, targetInput);
      await f.send(source.agent, 'Later input.');
      const before = await f.readStored(source.agent.id);
      const target = userEvents(before)[1];
      const header = (await f.ctx.sessionPersistence.stat(source.agent.id)).header;
      const result = await f.engine.execute(editCommand(source.agent, target, action, 'Edited input.'));
      assert.deepEqual(result, { sourceSessionId: source.agent.id, historyUpdated: true });
      const regenerated = f.ctx.agents.get(source.agent.id);
      await regenerated.whenIdle();
      await f.host.flush(regenerated);
      assert.notEqual(regenerated, source.agent);
      assert.deepEqual(regenerated.session.header, header);
      const stored = await f.readStored(source.agent.id);
      assert.deepEqual(stored.slice(0, target.seq), before.slice(0, target.seq));
      const inputs = userEvents(stored);
      assert.equal(inputs.length, 2);
      assert.notEqual(inputs[1].data.id, target.data.id);
      assert.deepEqual(inputs[1].data.content,
        action === 'edit' ? [{ type: 'text', text: 'Edited input.' }] : targetInput.content);
      const seen = f.requests.at(-1).messages;
      assert.equal(seen.some(message => text(message) === 'Later input.'), false);
      assert.equal(seen.some(message => message.role === 'assistant' && text(message).includes('Original input.')), false);
      assert.ok(seen.some(message => message.role === 'assistant' && text(message).includes('Earlier input.')));
      assert.deepEqual(f.workspace.sessionIds, [source.agent.id]);
      assert.equal((await f.ctx.sessionPersistence.list()).length, 1);
      // Retrying the old form cannot silently submit a second regeneration.
      await assert.rejects(f.engine.execute(editCommand(source.agent, target)), code('session-changed'));
    });
  }
}

test('regeneration clears pending inputs and records the edited message exactly once', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  source.agent.inbox.append('next-turn', human('First queued target.'));
  source.agent.inbox.append('next-turn', human('Old pending input.'));
  await f.send(source.agent, 'Wake the queued inputs.');
  const target = userEvents(source.agent.session.snapshotEvents())[0];
  const requestCount = f.requests.length;
  await f.engine.execute(editCommand(source.agent, target, 'edit', 'Replacement only.'));
  const agent = f.ctx.agents.get(source.agent.id);
  await agent.whenIdle();
  assert.equal(f.requests.length, requestCount + 1);
  assert.deepEqual(f.requests.at(-1).messages.filter(m => m.role === 'user').map(text), ['Replacement only.']);
  assert.deepEqual(userEvents(agent.session.snapshotEvents()).map(e => text(e.data)), ['Replacement only.']);
});

test('a seq-zero historical user input is edited in its existing session', options, async t => {
  const f = await createRuntime(t);
  const target = { type: 'user/message', seq: 0, time: 1, data: human('Imported first input.'), surfaceOp: 'append' };
  const source = await f.createSource({ seed: [target] });
  await f.host.flush(source.agent);
  await f.engine.execute(editCommand(source.agent, target, 'edit', 'Changed first input.'));
  const agent = f.ctx.agents.get(source.agent.id);
  await agent.whenIdle();
  assert.equal(agent.session.inheritedEventCount, 0);
  assert.equal(agent.session.header.parentSession, undefined);
  assert.deepEqual(userEvents(agent.session.snapshotEvents()).map(e => text(e.data)), ['Changed first input.']);
});

test('editing stops the old running turn and preserves the title and current model', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  const target = userEvents(await f.send(source.agent, 'Selected input.'))[0];
  source.agent.session.append('session/title', { title: 'My conversation', messageSeqs: [], source: { kind: 'user' } });
  f.agentController.selectForNextRequest(source.agent, { provider: 'offline', model: 'current-model' });
  await f.stop(source.agent, 'Later stopped input.');
  const started = Promise.withResolvers();
  let canceled = false;
  let waiting = true;
  f.setResponse(async function* (request) {
    if (waiting) {
      waiting = false;
      started.resolve();
      await new Promise(resolve => request.signal.addEventListener('abort', () => { canceled = true; resolve(); }, { once: true }));
      request.signal.throwIfAborted();
    }
    yield* chunks('Regenerated answer.');
  });
  source.agent.followup(human('Still running.'));
  await started.promise;
  await f.engine.execute(editCommand(source.agent, target, 'edit', 'Changed request.'));
  const agent = f.ctx.agents.get(source.agent.id);
  await agent.whenIdle();
  assert.equal(canceled, true);
  assert.deepEqual(
    agent.session.snapshotEvents().findLast(e => e.type === 'session/title')?.data.title,
    'My conversation',
  );
  assert.deepEqual(f.requests.at(-1).messages.filter(m => m.role === 'user').map(text), ['Changed request.']);
  assert.equal(f.requests.at(-1).model, 'current-model');
});

test('retry keeps a model selected while an older request was being prepared', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  f.agentController.selectionFor(source.agent);
  const target = userEvents(await f.send(source.agent, 'Selected input.'))[0];
  f.agentController.selectForNextRequest(source.agent, { provider: 'offline', model: 'model-a' });

  const preparing = Promise.withResolvers();
  const release = Promise.withResolvers();
  const prepare = f.ctx.llm.prepareCall.bind(f.ctx.llm);
  let delay = true;
  f.ctx.llm.prepareCall = async call => {
    if (delay) {
      delay = false;
      preparing.resolve();
      await release.promise;
    }
    return prepare(call);
  };
  try {
    source.agent.followup(human('Later input.'));
    await preparing.promise;
    f.agentController.selectForNextRequest(source.agent, { provider: 'offline', model: 'model-b' });
  } finally {
    release.resolve();
  }
  await source.agent.whenIdle();
  assert.equal(f.requests.at(-1).model, 'model-a');
  assert.equal(f.ctx.sessionProjections.stateOf(source.agent.session, 'modelSelection').pending.model, 'model-b');

  await f.engine.execute(editCommand(source.agent, target));
  await f.ctx.agents.get(source.agent.id).whenIdle();
  assert.equal(f.requests.at(-1).model, 'model-b');
});

test('runtime-owned Agents cannot be edited even when their durable header has no parent lineage', options, async t => {
  const f = await createRuntime(t);
  const owner = await f.createSource();
  const child = await f.createSource({ parentAgent: owner.agent });
  const events = await f.send(child.agent, 'Managed agent input.');
  assert.equal(child.agent.session.header.parentSession, undefined);
  assert.equal(child.agent.session.header.origin, undefined);
  assert.equal(f.ctx.agents.isOwnedBy(child.agent.id, owner.agent), true);
  const inspection = await f.engine.inspect({ sessionId: child.agent.id });
  assert.equal(inspection.ordinary, false);
  await assert.rejects(f.submit(editCommand(child.agent, userEvents(events)[0])), code('owned-session'));
});

test('exact message resolution stays read-only for a cold session', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  for (const value of ['one', 'two', 'three']) await f.send(source.agent, value);
  const before = await f.readStored(source.agent.id);
  await source.dispose();
  const selected = await f.engine.inspect({
    sessionId: source.agent.id,
    eventSeq: userEvents(before)[1].seq,
  });
  assert.equal(selected.message.text, 'two');
  assert.equal(selected.message.editable, true);
  await assert.rejects(
    f.engine.inspect({
      sessionId: source.agent.id,
      eventSeq: before.find(event => event.type === 'assistant/message').seq,
    }),
    code('message-not-editable'),
  );
  assert.equal(f.ctx.agents.get(source.agent.id), undefined);
  assert.deepEqual(await f.readStored(source.agent.id), before);
  assert.equal(f.requests.length, 3);
});

test('a cold stopped Session continues directly on stock AgentLoop without adding user text', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  const stopped = await f.stop(source.agent);
  const count = userEvents(stopped).length;
  const id = source.agent.id;
  await source.dispose();
  const inspection = await f.engine.inspect({ sessionId: id });
  assert.equal(inspection.status, 'cold');
  assert.equal(inspection.continuation.available, true);
  const { result } = await f.submit({ sessionId: id, action: 'continue' });
  assert.equal(result.sourceSessionId, id);
  assert.equal(result.childSessionId, undefined);
  const resumed = f.ctx.agents.get(id);
  await resumed.whenIdle();
  await f.ctx.sessions.flush(resumed.session);
  const stored = await f.readStored(id);
  assert.equal(userEvents(stored).length, count);
  assert.equal(
    stored.slice(stopped.length).filter(e => e.type === 'agent/inbox/spliced').length,
    0,
  );
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].messages.at(-1).role, 'assistant');
  assert.equal(text(f.requests[1].messages.at(-1)), 'Partial response before user stop.');
});

test('direct continuation retains native tool execution and subsequent model step', options, async t => {
  const f = await createRuntime(t);
  let executed = 0;
  f.ctx.tools.register(
    defineTool({
      name: 'local_probe',
      description: 'Pure offline fixture tool.',
      parameters: { value: { type: 'number', required: true } },
      output: {
        schema: { type: 'number' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        assert.equal(exec.agent.id, source.agent.id);
        executed++;
        return args.value * 2;
      },
    }),
  );
  const source = await f.createSource();
  await f.stop(source.agent);
  f.setResponse((_request, number) =>
    number === 2
      ? [
          { type: 'block-start', blockType: 'tool-call', index: 0 },
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'call-1',
            name: 'local_probe',
            argumentsDelta: '{"value":7}',
          },
          {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'call-1',
              name: 'local_probe',
              arguments: '{"value":7}',
            },
          },
          { type: 'finish', reason: { kind: 'tool-use' } },
        ]
      : chunks('Tool result consumed.'),
  );
  await f.submit({ sessionId: source.agent.id, action: 'continue' });
  await source.agent.whenIdle();
  assert.equal(executed, 1);
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].messages.at(-1).role, 'tool');
  assert.equal(f.requests[2].messages.at(-1).content[0].text, '14');
});

test('a failed direct continuation attempt leaves the session resumable without adding user messages', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  const before = await f.stop(source.agent);
  const normalResponse = f.setResponse(async function* () {
    throw new Error('Offline provider refuses assistant-tail continuation');
  });
  await f.submit({ sessionId: source.agent.id, action: 'continue' });
  await source.agent.whenIdle();
  assert.equal(f.requests.length, 2);
  assert.equal(userEvents(source.agent.session.snapshotEvents()).length, userEvents(before).length);
  assert.equal(
    source.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason
      .kind,
    'error',
  );
  const inspection = await f.engine.inspect({ sessionId: source.agent.id });
  assert.equal(inspection.continuation.available, true);
  f.setResponse(normalResponse);
  await f.submit({ sessionId: source.agent.id, action: 'continue' });
  await source.agent.whenIdle();
  assert.equal(userEvents(source.agent.session.snapshotEvents()).length, userEvents(before).length);
  assert.equal(f.requests.length, 3);
});

test('a max-tokens turn can be explicitly continued without another user input', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  const normalResponse = f.setResponse(() => chunks('Incomplete answer.', { kind: 'max-tokens' }));
  const before = await f.send(source.agent, 'Long task.');
  assert.equal(before.findLast(event => event.type === 'turn/end').data.reason.kind, 'max-tokens');
  assert.equal((await f.engine.inspect({ sessionId: source.agent.id })).continuation.available, true);
  f.setResponse(normalResponse);
  await f.submit({ sessionId: source.agent.id, action: 'continue' });
  await source.agent.whenIdle();
  assert.equal(userEvents(source.agent.session.snapshotEvents()).length, userEvents(before).length);
  assert.equal(f.requests.length, 2);
});

test('a failed rewrite keeps the old history and republishes its agent', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  const before = await f.send(source.agent, 'Keep the original.');
  const persistence = f.ctx.sessionPersistence;
  const encode = persistence.encodeMaterialization;
  persistence.encodeMaterialization = async () => { throw new Error('Write preparation failed'); };
  try {
    await assert.rejects(f.engine.execute(editCommand(source.agent, userEvents(before)[0], 'edit', 'Not committed.')), /Write preparation failed/);
  } finally { persistence.encodeMaterialization = encode; }
  const stored = await f.readStored(source.agent.id);
  assert.deepEqual(stored.slice(0, before.length), before);
  assert.ok(f.ctx.agents.get(source.agent.id));
  assert.equal(f.requests.length, 1);
});

test('post-commit activation failure keeps the edited input durable and does not resubmit it', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  const before = await f.send(source.agent, 'Original.');
  const resolve = f.host.resolve;
  f.host.resolve = async () => { throw new Error('Activation unavailable'); };
  try {
    await assert.rejects(f.engine.execute(editCommand(source.agent, userEvents(before)[0], 'edit', 'Saved edit.')), error =>
      error.code === 'session-edit/regeneration-failed' && error.data.historyUpdated === true);
  } finally { f.host.resolve = resolve; }
  assert.deepEqual(userEvents(await f.readStored(source.agent.id)).map(e => text(e.data)), ['Saved edit.']);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.engine.inspect({ sessionId: source.agent.id })).continuation.available, true);
  await f.engine.execute({ sessionId: source.agent.id, action: 'continue' });
  await f.ctx.agents.get(source.agent.id).whenIdle();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests.at(-1).messages.filter(m => m.role === 'user').map(text), ['Saved edit.']);
});

test('another writer prevents a cold history edit without changing its log', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  const before = await f.send(source.agent, 'Owned elsewhere.');
  await source.dispose();
  const writer = await f.ctx.sessionPersistence.open(source.agent.id, 'write');
  try {
    await assert.rejects(f.engine.execute(editCommand(source.agent, userEvents(before)[0], 'edit', 'No write.')),
      error => error.name === 'SessionAlreadyOwnedError');
    assert.deepEqual(await f.readStored(source.agent.id), before);
  } finally { await writer.close(); }
});

test('repeated edits keep one identity and release the old lifecycle effects', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  await f.send(source.agent, 'First version.');
  for (let i = 1; i <= 3; i++) {
    const agent = f.ctx.agents.get(source.agent.id);
    const target = userEvents(agent.session.snapshotEvents())[0];
    await f.engine.execute(editCommand(agent, target, 'edit', 'Version ' + i));
    await f.ctx.agents.get(source.agent.id).whenIdle();
  }
  const current = f.ctx.agents.get(source.agent.id);
  await f.host.flush(current);
  assert.deepEqual(userEvents(await f.readStored(source.agent.id)).map(e => text(e.data)), ['Version 3']);
  assert.equal(f.ctx.root.fiber.getEffects().filter(effect => effect.label === 'agentLoop.lifecycle(' + source.agent.id + ')').length, 1);
  assert.equal(current.loopCtx.fiber.getEffects().filter(effect => effect.label === 'agentLoop.scope(' + source.agent.id + ')').length, 1);
  assert.equal(f.requests.length, 4);
});

test('editing inherited history shortens its inherited cut without changing the parent', options, async t => {
  const f = await createRuntime(t);
  const parent = await f.createSource();
  await f.send(parent.agent, 'Parent first.');
  const events = await f.send(parent.agent, 'Parent second.');
  const source = await f.createSource({
    seed: buildForkSeed(events, events.length - 1),
    inheritedEventCount: events.length,
    meta: { parentSession: parent.agent.id, isSeeded: true },
  });
  const target = userEvents(events)[0];
  await f.engine.execute(editCommand(source.agent, target, 'edit', 'Edited inherited input.'));
  const current = f.ctx.agents.get(source.agent.id);
  await current.whenIdle();
  await f.host.flush(current);
  assert.equal(current.session.header.parentSession, parent.agent.id);
  assert.equal(current.session.inheritedEventCount, target.seq);
  assert.deepEqual(userEvents(await f.readStored(source.agent.id)).map(e => text(e.data)), ['Edited inherited input.']);
  assert.deepEqual(await f.readStored(parent.agent.id), events);
  assert.equal((await f.ctx.sessionPersistence.list()).length, 2);
});

test('rewriting drops persisted projection watermarks from the replaced history', options, async t => {
  const f = await createRuntime(t, {}, { cache: true });
  f.ctx.sessionProjections.register({
    key: 'recordedInputs', stateVersion: 1, stateSchema: z.array(z.string()),
    init: () => [],
    apply: (state, event) => event.type === 'user/message' && event.data.source.kind === 'user'
      ? [...state, text(event.data)] : state,
  });
  const source = await f.createSource();
  const normal = f.setResponse(async function* () { throw new Error('Stopped before output'); });
  const events = await f.send(source.agent, 'Old cached input.');
  await f.ctx.sessionProjectionCache.write(source.agent.session);
  assert.deepEqual(f.ctx.sessionProjectionCache.table.get(source.agent.id).rows.recordedInputs.val, ['Old cached input.']);
  f.setResponse(normal);
  await f.engine.execute(editCommand(source.agent, userEvents(events)[0], 'edit', 'New cached input.'));
  const current = f.ctx.agents.get(source.agent.id);
  await current.whenIdle();
  await f.ctx.sessionProjectionCache.write(current.session);
  assert.deepEqual(f.ctx.sessionProjectionCache.table.get(source.agent.id).rows.recordedInputs.val, ['New cached input.']);
});

test('unsupported storage is rejected before retiring the live conversation', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  const events = await f.send(source.agent, 'Keep this conversation active.');
  const persistence = f.ctx.sessionPersistence;
  for (const method of ['encodeMaterialization', 'locate', 'open']) {
    const original = persistence[method];
    persistence[method] = undefined;
    try {
      await assert.rejects(f.engine.execute(editCommand(source.agent, userEvents(events)[0], 'edit', 'Not applied.')), code('unsupported-backend'));
      assert.equal(f.ctx.agents.get(source.agent.id), source.agent);
      assert.deepEqual(source.agent.session.snapshotEvents(), events);
    } finally { persistence[method] = original; }
  }
  assert.deepEqual(await f.readStored(source.agent.id), events);
  assert.equal(f.requests.length, 1);
});

test('an unknown session format blocks rewriting without blocking inspection or native continuation', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  const events = await f.stop(source.agent);
  const target = userEvents(events)[0];
  const snapshot = f.host.snapshot.bind(f.host);
  // Simulate a new header format with unchanged events and host interfaces.
  t.mock.method(f.host, 'snapshot', async id => {
    const value = await snapshot(id);
    return { ...value, header: { ...value.header, version: 5 } };
  });
  const inspected = await f.engine.inspect({ sessionId: source.agent.id, eventSeq: target.seq });
  assert.equal(inspected.message.text, text(target.data));
  assert.equal(inspected.continuation.available, true);
  for (const action of ['edit', 'retry']) {
    await assert.rejects(f.engine.execute(editCommand(source.agent, target, action, 'Not applied.')), code('unsupported-format'));
  }
  assert.equal(f.ctx.agents.get(source.agent.id), source.agent);
  assert.deepEqual(source.agent.session.snapshotEvents(), events);
  assert.deepEqual(await f.readStored(source.agent.id), events);
  assert.equal(f.requests.length, 1);

  await f.engine.execute({ sessionId: source.agent.id, action: 'continue' });
  await source.agent.whenIdle();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(userEvents(source.agent.session.snapshotEvents()), userEvents(events));
});

test('an unknown agent teardown blocks rewriting before retirement but allows continuation', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  const events = await f.stop(source.agent);
  const lifecycle = f.ctx.root.fiber.getEffects().find(effect => effect.label === 'agentLoop.lifecycle(' + source.agent.id + ')');
  assert.ok(lifecycle);
  const label = lifecycle.label;
  lifecycle.label = 'unknown-agent-lifecycle';
  try {
    await assert.rejects(f.engine.execute(editCommand(source.agent, userEvents(events)[0], 'edit', 'Not applied.')), code('unsupported-runtime'));
    assert.equal(f.ctx.agents.get(source.agent.id), source.agent);
    assert.deepEqual(source.agent.session.snapshotEvents(), events);
    assert.deepEqual(await f.readStored(source.agent.id), events);
    assert.equal(f.requests.length, 1);

    await f.engine.execute({ sessionId: source.agent.id, action: 'continue' });
    await source.agent.whenIdle();
    assert.equal(f.requests.length, 2);
    assert.deepEqual(userEvents(source.agent.session.snapshotEvents()), userEvents(events));
  } finally { lifecycle.label = label; }
});

test('missing continuation hooks fail before waking the agent or changing history', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  const events = await f.stop(source.agent);
  for (const [owner, method] of [[source.agent, 'wakeDriver'], [source.agent, 'whenIdle'], [source.agent.ctx, 'on']]) {
    const original = owner[method];
    owner[method] = undefined;
    try {
      await assert.rejects(f.engine.execute({ sessionId: source.agent.id, action: 'continue' }), code('unsupported-runtime'));
      assert.equal(f.ctx.agents.get(source.agent.id), source.agent);
      assert.deepEqual(source.agent.session.snapshotEvents(), events);
    } finally { owner[method] = original; }
  }
  assert.deepEqual(await f.readStored(source.agent.id), events);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.engine.inspect({ sessionId: source.agent.id })).continuation.available, true);
  await f.engine.execute({ sessionId: source.agent.id, action: 'continue' });
  await source.agent.whenIdle();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(userEvents(source.agent.session.snapshotEvents()), userEvents(events));
});

test('editing the first message refreshes an auto-generated title without pinning it as a user rename', options, async t => {
  const f = await createRuntime(t);
  await f.ctx
    .plugin(SessionTitleService, { fallbackMaxWords: 8, fallbackMaxBytes: 80, maxTitleBytes: 120 })
    .await();
  const source = await f.createSource();
  const events = await f.send(source.agent, 'Temporary initial prompt');
  await f.ctx.sessionTitle.ensureFallback(source.agent.session);
  await f.host.flush(source.agent);
  assert.deepEqual(f.ctx.sessionTitle.get(source.agent.session)?.title, 'Temporary initial prompt');
  assert.deepEqual(f.ctx.sessionTitle.get(source.agent.session)?.source, { kind: 'fallback' });

  const target = userEvents(events)[0];
  await f.engine.execute(editCommand(source.agent, target, 'edit', 'Updated first prompt'));
  const regenerated = f.ctx.agents.get(source.agent.id);
  await regenerated.whenIdle();
  await f.host.flush(regenerated);

  const snapshot = f.ctx.sessionTitle.get(regenerated.session);
  assert.equal(snapshot?.title, 'Updated first prompt');
  assert.deepEqual(snapshot?.source, { kind: 'fallback' });
});

test('editing and retrying messages with image and file attachments preserves durable attachment references', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  const imageAttachment = {
    attachmentId: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    mediaType: 'image/png',
    bytes: 64,
    width: 8,
    height: 8,
    name: 'screenshot.png',
  };
  const fileAttachment = {
    attachmentId: 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    name: 'spec.md',
    bytes: 120,
  };
  const base = human('Inspect this attachment.');
  const events = await f.send(source.agent, {
    ...base,
    content: [
      { type: 'image', attachment: imageAttachment },
      { type: 'file', attachment: fileAttachment },
      ...base.content,
    ],
  });
  const target = userEvents(events)[0];
  const inspected = await f.engine.inspect({ sessionId: source.agent.id, eventSeq: target.seq });
  assert.equal(inspected.message.editable, true);

  await f.engine.execute(editCommand(source.agent, target, 'edit', 'Updated instructions for attachments.'));
  const editedAgent = f.ctx.agents.get(source.agent.id);
  await editedAgent.whenIdle();
  await f.host.flush(editedAgent);
  const storedAfterEdit = userEvents(await f.readStored(source.agent.id))[0];
  assert.deepEqual(storedAfterEdit.data.content, [
    { type: 'image', attachment: imageAttachment },
    { type: 'file', attachment: fileAttachment },
    { type: 'text', text: 'Updated instructions for attachments.' },
  ]);

  await f.engine.execute(editCommand(editedAgent, storedAfterEdit, 'retry'));
  const retriedAgent = f.ctx.agents.get(source.agent.id);
  await retriedAgent.whenIdle();
  await f.host.flush(retriedAgent);
  const storedAfterRetry = userEvents(await f.readStored(source.agent.id))[0];
  assert.deepEqual(storedAfterRetry.data.content, storedAfterEdit.data.content);
});
