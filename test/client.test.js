import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientController } from '../src/client-controller.js';

const ok = value => ({ ok: true, value });
const message = (eventSeq, text = `message ${eventSeq}`) => ({
  eventSeq,
  messageId: `message-${eventSeq}`,
  text,
  time: 100,
  editable: true,
});
const target = { sessionId: 'source', eventSeq: 8, text: 'message 8' };

function fixture(overrides = {}) {
  const calls = [];
  const navigated = [];
  const facts = {
    sessionId: 'source',
    status: 'idle',
    archived: false,
    ordinary: true,
    headSeq: 100,
    continuation: { available: true },
  };
  const handlers = {
    inspect: request =>
      ok({
        ...facts,
        sessionId: request.sessionId,
        ...(request.eventSeq === undefined ? {} : { message: message(request.eventSeq) }),
      }),
    execute: request => ok({ sourceSessionId: request.sessionId, ...(request.action === 'continue' ? {} : { historyUpdated: true }) }),
    ...overrides,
  };
  const rpc = Object.fromEntries(
    Object.keys(handlers).map(name => [
      name,
      async request => {
        calls.push({ name, request });
        return handlers[name](request);
      },
    ]),
  );
  const controller = createClientController({
    rpc,
    navigate: id => navigated.push(id),
  });
  return { controller, calls, navigated, facts };
}

test('editing resolves the exact message ID and submits from the message', async () => {
  const f = fixture();
  await f.controller.openEdit(target);
  assert.deepEqual(f.calls[0].request, { sessionId: 'source', eventSeq: 8 });
  assert.equal(f.controller.getSnapshot().panel.text, 'message 8');
  f.controller.setText('changed $text\nsecond line');
  await f.controller.submitEdit();
  assert.deepEqual(
    f.calls.map(call => call.name),
    ['inspect', 'execute', 'inspect'],
  );
  assert.deepEqual(f.calls[1].request, {
    sessionId: 'source',
    action: 'edit',
    eventSeq: 8,
    messageId: 'message-8',
    replacementText: 'changed $text\nsecond line',
  });
  assert.equal(f.controller.getSnapshot().panel, null);
  assert.deepEqual(f.navigated, ['source']);
  f.controller.dispose();
});

test('retry is one action without opening a dialog and sends no replacement text', async () => {
  const f = fixture();
  f.facts.status = 'running';
  await f.controller.retryMessage({ ...target, messageId: 'message-8' });
  assert.deepEqual(f.calls.filter(call => call.name === 'execute'), [
    {
      name: 'execute',
      request: {
        sessionId: 'source',
        action: 'retry',
        eventSeq: 8,
        messageId: 'message-8',
      },
    },
  ]);
  assert.equal(f.controller.getSnapshot().panel, null);
  assert.deepEqual(f.navigated, ['source']);
  f.controller.dispose();
});

test('double retry clicks share identity resolution and only submit once', async () => {
  const gate = Promise.withResolvers();
  const f = fixture({ inspect: () => gate.promise });
  const first = f.controller.retryMessage(target);
  const second = f.controller.retryMessage(target);
  await Promise.resolve();
  assert.equal(f.calls.length, 1);
  gate.resolve(ok({ ...f.facts, message: message(8) }));
  await Promise.all([first, second]);
  assert.equal(f.calls.filter(call => call.name === 'execute').length, 1);
  assert.deepEqual(f.navigated, ['source']);
  f.controller.dispose();
});

test('closing the editor while submitting prevents late navigation', async () => {
  const gate = Promise.withResolvers();
  const f = fixture({ execute: () => gate.promise });
  await f.controller.openEdit({ ...target, messageId: 'message-8' });
  f.controller.setText('edited text');
  const task = f.controller.submitEdit();
  await Promise.resolve();
  assert.equal(f.controller.getSnapshot().panel.busy, true);
  f.controller.close();
  assert.equal(f.controller.getSnapshot().panel, null);
  gate.resolve(ok({ sourceSessionId: 'source', historyUpdated: true }));
  await task;
  assert.equal(f.controller.getSnapshot().panel, null);
  assert.deepEqual(f.navigated, []);
  f.controller.dispose();
});

test('late identity lookup does not reopen an editor or overwrite another conversation', async () => {
  const gate = Promise.withResolvers();
  const f = fixture({
    inspect: request =>
      request.sessionId === 'source'
        ? gate.promise
        : ok({ ...f.facts, sessionId: 'new', message: message(8) }),
  });
  const first = f.controller.openEdit(target);
  f.controller.close();
  await f.controller.openEdit({ ...target, sessionId: 'new' });
  gate.resolve(ok({ ...f.facts, message: message(8) }));
  await first;
  assert.equal(f.controller.getSnapshot().panel.sessionId, 'new');
  assert.equal(f.calls.filter(call => call.name === 'execute').length, 0);
  f.controller.dispose();
});

test('a rejected edit keeps its inline draft', async () => {
  const f = fixture({
    execute: () => ({ ok: false, error: { code: 'session-edit/session-changed', message: 'Changed' } }),
  });
  await f.controller.openEdit({ ...target, messageId: 'message-8' });
  f.controller.setText('draft to retain');
  await f.controller.submitEdit();
  assert.equal(f.controller.getSnapshot().panel.text, 'draft to retain');
  assert.equal(f.controller.getSnapshot().panel.busy, false);
  assert.equal(f.controller.getSnapshot().panel.error.code, 'session-edit/session-changed');
  f.controller.dispose();
});

test('a rejected one-click retry surfaces a notice', async () => {
  const f = fixture({
    execute: () => ({ ok: false, error: { code: 'session-edit/forbidden', message: 'Forbidden' } }),
  });
  await f.controller.retryMessage({ ...target, messageId: 'message-8' });
  assert.equal(f.controller.getSnapshot().panel, null);
  assert.equal(f.controller.getSnapshot().notice.code, 'session-edit/forbidden');
  f.controller.clearNotice();
  assert.equal(f.controller.getSnapshot().notice, null);
  f.controller.dispose();
});

test('a late retry result never closes an editor opened afterwards', async () => {
  const gate = Promise.withResolvers();
  const f = fixture({ execute: () => gate.promise });
  const retry = f.controller.retryMessage({ ...target, messageId: 'message-8' });
  await Promise.resolve();
  await f.controller.openEdit({ ...target, messageId: 'message-8' });
  gate.resolve(ok({ sourceSessionId: 'source', historyUpdated: true }));
  await retry;
  const state = f.controller.getSnapshot();
  assert.equal(state.panel.eventSeq, 8);
  assert.deepEqual(f.navigated, []);
  assert.equal(state.notice.sessionId, 'source');
  f.controller.dispose();
});

test('continuation uses cached facts then refreshes without navigating', async () => {
  const f = fixture();
  await f.controller.loadSession('source');
  await f.controller.continueSession('source');
  assert.deepEqual(
    f.calls.map(call => call.name),
    ['inspect', 'execute', 'inspect'],
  );
  assert.deepEqual(f.navigated, []);
  f.controller.dispose();
});

test('continuation attempts an available session directly and surfaces unavailable error', async () => {
  const f = fixture();
  await f.controller.continueSession('source');
  assert.deepEqual(f.calls.find(call => call.name === 'execute').request, {
    sessionId: 'source',
    action: 'continue',
  });
  f.controller.dispose();

  const denied = fixture();
  denied.facts.continuation = { available: false };
  await denied.controller.continueSession('source');
  assert.equal(denied.calls.filter(call => call.name === 'execute').length, 0);
  assert.equal(denied.controller.getSnapshot().notice.code, 'session-edit/continuation-unsupported');
  denied.controller.dispose();
});

test('continuation leaves an inline edit intact on success and reports failures via notice', async () => {
  let reject = false;
  const f = fixture({ execute: () => reject
    ? { ok: false, error: { code: 'session-edit/host-error', message: 'Failed' } }
    : ok({ sourceSessionId: 'source' }),
  });
  await f.controller.openEdit({ ...target, messageId: 'message-8' });
  f.controller.setText('Unsent inline edit');
  const editor = f.controller.getSnapshot().panel;
  await f.controller.continueSession('source');
  assert.equal(f.controller.getSnapshot().panel, editor);
  assert.deepEqual(f.navigated, []);
  reject = true;
  await f.controller.continueSession('source');
  assert.equal(f.controller.getSnapshot().panel, editor);
  assert.equal(f.controller.getSnapshot().notice.code, 'session-edit/host-error');
  f.controller.dispose();
});

test('drafts belong to a message identity rather than a reused event position', async () => {
  const f = fixture();
  await f.controller.openEdit({ ...target, messageId: 'old-message', text: 'Old text' });
  f.controller.setText('Old unsent draft');
  f.controller.close();
  await f.controller.openEdit({ ...target, messageId: 'rewritten-message', text: 'Rewritten text' });
  assert.equal(f.controller.getSnapshot().panel.text, 'Rewritten text');
  f.controller.dispose();
});

test('a stale bubble cannot silently target a rewritten message at the same seq', async () => {
  const f = fixture();
  await f.controller.openEdit({ ...target, text: 'Text from the old history' });
  assert.equal(f.controller.getSnapshot().panel.error.code, 'session-edit/session-changed');
  await f.controller.submitEdit();
  assert.equal(f.calls.filter(call => call.name === 'execute').length, 0);
  f.controller.dispose();
});

test('a committed edit failure reloads its saved history without resubmitting the edit', async () => {
  const f = fixture({ execute: () => ({ ok: false, error: {
    code: 'session-edit/regeneration-failed', message: 'Saved, activation failed', details: { historyUpdated: true },
  } }) });
  await f.controller.openEdit({ ...target, messageId: 'message-8' });
  f.controller.setText('Saved edit');
  await f.controller.submitEdit();
  assert.equal(f.controller.getSnapshot().panel, null);
  assert.equal(f.controller.getSnapshot().notice.historyUpdated, true);
  assert.equal(f.calls.filter(call => call.name === 'execute').length, 1);
  assert.deepEqual(f.navigated, []);
  f.controller.dispose();
});
