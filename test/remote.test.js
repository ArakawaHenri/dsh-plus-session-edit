import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import { SessionEditService } from '../index.js';
import * as sessionEditPlugin from '../index.js';
import { parseRequest, remoteContribution } from '../remote.js';
import { SessionEditError } from '../lib/errors.js';

const methods = ['inspect', 'execute'];
const valid = {
  inspect: { sessionId: 'fixture-session' },
  execute: { sessionId: 'fixture-session', action: 'continue' },
};

function rpcFixture(t, { principal = 'owner', failure } = {}) {
  const ctx = new Context();
  const calls = [];
  t.after(() => ctx.fiber.dispose());
  const engine = Object.fromEntries(
    methods.map(method => [
      method,
      async request => {
        calls.push({ method, request });
        if (failure) throw failure;
        return { method, request: parseRequest(method, request) };
      },
    ]),
  );
  new SessionEditService(ctx, engine);
  const caller =
    principal === null
      ? ctx
      : ctx.extend({ invocation: { peer: { principal: { kind: principal } } } });
  const service = caller.get('sessionEdit');
  const descriptors = remoteContribution().descriptors;

  installConnection(ctx, {
    transport: {
      async fetch(url, init) {
        assert.equal(init.method, 'POST');
        const frame = JSON.parse(init.body);
        const method = frame.method.split('/')[1];
        assert.equal(url, `api/sessionEdit/${method}`);
        assert.equal(frame.method, `sessionEdit/${method}`);
        const descriptor = descriptors.find(item => item.method === method);
        assert.ok(descriptor);
        let result;
        try {
          const request = descriptor.parameters[0].codec.create().parse(frame.payload.args.request);
          result = { ok: true, value: await service[method](request) };
        } catch (error) {
          const normalized =
            remoteErrorOf(error) ??
            (error instanceof TypeError
              ? { code: 'gateway/bad-request', message: error.message, details: {} }
              : undefined);
          assert.ok(normalized, `Unexpected non-RPC error: ${String(error)}`);
          result = {
            ok: false,
            error: {
              code: normalized.code,
              message: normalized.message,
              details: normalized.details,
            },
          };
        }
        return Response.json({ type: 'server-response', rpcId: frame.rpcId, result });
      },
    },
  });

  return {
    calls,
    service,
    invoke(method, request = valid[method]) {
      return ctx.get('connection').rpc.call('/api', `sessionEdit/${method}`, { args: { request } });
    },
  };
}

test('host startup registers the RPC methods without reading or mutating sessions', async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const registrations = [];
  const unexpected = () => assert.fail('Startup must not inspect, fork, resume or send any Session');
  for (const [name, service] of Object.entries({
    typert: {
      register: value => {
        registrations.push(value);
      },
    },
    sessionController: { resolveAgent: unexpected },
    sessionQuery: { observeSession: unexpected },
    sessions: { get: unexpected, prepare: unexpected },
    agents: { get: unexpected, create: unexpected, resume: unexpected },
    sessionPersistence: { stat: unexpected, create: unexpected },
    workspaceRegistry: { list: unexpected },
  })) {
    ctx.provide(name, service);
  }
  const fiber = ctx.plugin(sessionEditPlugin);
  await fiber.await();
  assert.equal(fiber.state, 2);
  assert.ok(ctx.get('sessionEdit'));
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].package, '@dshplus/session-edit');
  assert.equal(registrations[0].face, 'host');
  assert.deepEqual(
    registrations[0].invocations.map(item => item.method),
    methods,
  );
  await fiber.dispose();
  assert.equal(ctx.get('sessionEdit'), undefined);
});

test('all public descriptors use the strict direct request contract', () => {
  const contribution = remoteContribution();
  assert.equal(contribution.package, '@dshplus/session-edit');
  assert.deepEqual(
    contribution.descriptors.map(item => item.method),
    methods,
  );
  for (const descriptor of contribution.descriptors) {
    assert.equal(descriptor.id, `@dshplus/session-edit#sessionEdit/${descriptor.method}`);
    assert.equal(descriptor.service, 'sessionEdit');
    assert.equal(descriptor.namespace, 'sessionEdit');
    assert.deepEqual(descriptor.invocation, { kind: 'direct' });
    assert.equal(descriptor.parameters.length, 1);
    assert.equal(descriptor.parameters[0].wire, 'request');
    assert.equal(descriptor.parameters[0].codec.mode, 'strict');
    assert.equal(descriptor.parameters[0].codec.jsonSchema.additionalProperties, false);
    assert.deepEqual(
      descriptor.parameters[0].codec.create().parse(valid[descriptor.method]),
      parseRequest(descriptor.method, valid[descriptor.method]),
    );
  }
});

test('owner RPC methods round-trip the real Connection parser', async t => {
  const f = rpcFixture(t);
  for (const method of methods) {
    const result = await f.invoke(method);
    assert.deepEqual(result, {
      ok: true,
      value: { method, request: parseRequest(method, valid[method]) },
    });
  }
  assert.equal(f.calls.length, methods.length);
  assert.deepEqual(f.calls.find(call => call.method === 'execute').request, {
    sessionId: 'fixture-session',
    action: 'continue',
  });
});

test('every remote operation is owner-only, including read-only inspection', async t => {
  const f = rpcFixture(t, { principal: 'guest' });
  for (const method of methods) {
    const result = await f.invoke(method);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'session-edit/forbidden');
  }
  assert.equal(f.calls.length, 0);
});

test('trusted in-process invocation without a remote peer remains available', async t => {
  const f = rpcFixture(t, { principal: null });
  assert.deepEqual(await f.service.inspect(valid.inspect), {
    method: 'inspect',
    request: valid.inspect,
  });
  assert.equal(f.calls.length, 1);
});

test('unknown fields, invalid identities and incomplete action combinations fail before engine dispatch', async t => {
  const f = rpcFixture(t);
  const fork = { sessionId: 's', action: 'retry', eventSeq: 0, messageId: 'm' };
  const bad = [
    ['inspect', { sessionId: 's', includeSecrets: true }],
    ['inspect', { sessionId: 's', beforeSeq: -1 }],
    ['inspect', { sessionId: 's', limit: 101 }],
    ['inspect', { sessionId: 's\0hidden' }],
    ['inspect', { sessionId: 's', eventSeq: 0, beforeSeq: 1 }],
    ['execute', { ...fork, action: 'edit', replacementText: 'x', role: 'system' }],
    ['execute', { ...fork, replacementText: 'client tampering' }],
    ['execute', { ...fork, continuationMode: 'prompt' }],
    ['execute', { ...valid.execute, eventSeq: 0 }],
    ['execute', { ...valid.execute, messageId: 'm' }],
    ['execute', { ...valid.execute, replacementText: 'injected prompt' }],
    ['execute', { ...valid.execute, continuationMode: 'fallback' }],
    ['execute', { ...valid.execute, promptLocale: 'fr' }],
    ['execute', { ...valid.execute, promptLocale: 'en' }],
    ['execute', { ...fork, action: 'edit', replacementText: 'x', promptLocale: 'zh' }],
    ['execute', { ...fork, action: 'edit', replacementText: ' ' }],
    ['execute', { ...fork, action: 'edit', replacementText: 'x'.repeat(131073) }],
    ['execute', { ...fork, eventSeq: Number.MAX_SAFE_INTEGER + 1 }],
    ['execute', { ...fork, eventSeq: 0.5 }],
    ['execute', { sessionId: 's' }],
    ['execute', { action: 'continue' }],
    ['execute', { sessionId: 's', action: 'retry', eventSeq: 0 }],
    ['execute', { sessionId: 's', action: 'retry', messageId: 'm' }],
  ];
  for (const [method, request] of bad) {
    const result = await f.invoke(method, request);
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.error.code, 'gateway/bad-request');
  }
  assert.equal(f.calls.length, 0);
});

test('wire identities normalize consistently and seq zero is valid', () => {
  assert.deepEqual(parseRequest('execute', valid.execute), {
    sessionId: 'fixture-session',
    action: 'continue',
  });
  const fork = {
    sessionId: 's',
    action: 'edit',
    eventSeq: 0,
    messageId: 'm',
    replacementText: '  preserved\n',
  };
  assert.deepEqual(parseRequest('execute', fork), fork);
  assert.deepEqual(parseRequest('inspect', { sessionId: 's', eventSeq: 0 }), {
    sessionId: 's',
    eventSeq: 0,
  });
  for (const eventSeq of [-1, -0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseRequest('execute', { ...fork, eventSeq }), TypeError);
    assert.throws(() => parseRequest('inspect', { sessionId: 's', eventSeq }), TypeError);
  }
  for (const messageId of ['', ' ', 'm\0hidden', 'x'.repeat(513)]) {
    assert.throws(() => parseRequest('execute', { ...fork, messageId }), TypeError);
  }
});

for (const [label, error, expected] of [
  [
    'domain error details',
    new SessionEditError('session-changed', 'Reopen the selected history.', {
      reason: 'message-changed',
    }),
    {
      code: 'session-edit/session-changed',
      message: 'Reopen the selected history.',
      details: { reason: 'message-changed' },
    },
  ],
  [
    'native RemoteError',
    new RemoteError('session/writer-held', 'Another writer owns this session.', {
      sessionId: 'fixture-session',
    }),
    {
      code: 'session/writer-held',
      message: 'Another writer owns this session.',
      details: { sessionId: 'fixture-session' },
    },
  ],
  [
    'unexpected host failure',
    new Error('private filesystem path and provider credentials must not leak'),
    {
      code: 'session-edit/host-error',
      message: 'The host could not complete this action.',
      details: {},
    },
  ],
]) {
  test(`RPC preserves safe ${label} through its error envelope`, async t => {
    const f = rpcFixture(t, { failure: error });
    const result = await f.invoke('inspect');
    assert.equal(result.ok, false);
    assert.deepEqual(result.error, expected);
  });
}
