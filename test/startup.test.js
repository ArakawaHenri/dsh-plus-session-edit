import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import { buildClientSource } from '../scripts/build-client.js';

const clientSource = await buildClientSource();
const controllerRoot = dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-api-session-controller'));
const { SessionManager } = await import(pathToFileURL(join(controllerRoot, 'types/client/sessions/manager.js')));
const State = { PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3, DISPOSED: 4 };
const slotKey = options => `${options.name}:${options.key || options.id || ''}`;

function loadPlugin() {
  let entry;
  runInNewContext(clientSource, {
    window: {
      __ModuleLoader__: {
        load: value => {
          entry = value;
        },
      },
    },
    console,
    setTimeout,
    clearTimeout,
  });
  assert.equal(entry.id, '@dshplus/session-edit');
  return entry.factory(name => {
    if (name === 'react-dom' || name === '@deepseek-ai/dsh-client-ui-primitives') return {};
    assert.equal(name, 'react');
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
      useState: value => [value, () => {}],
      useEffect() {},
      useRef: value => ({ current: value }),
      useMemo: factory => factory(),
    };
  });
}

function fixture(t, { lateNamespace = false, deferredMount = false, sessions = {} } = {}) {
  const ctx = new Context();
  const slots = new Map();
  const dictionaries = new Map();
  const remoteListeners = new Map();
  const fibers = new Set();
  const errors = [];
  const counts = { mounts: 0, calls: 0, removedSlots: 0, removedLocale: 0 };
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  if (!deferredMount) gate.resolve();

  ctx.logger.exporter({
    export(message) {
      if (message.type === 'error') errors.push(...message.args);
    },
  });
  ctx.on('internal/plugin', fiber => fibers.add(fiber));

  class Slots extends Service {
    constructor() {
      super(ctx, 'slots');
    }
    inject(_name, callback) {
      return this.ctx.effect(callback);
    }
    register(options, component) {
      return this.ctx.effect(() => {
        const key = slotKey(options);
        assert.equal(slots.has(key), false);
        slots.set(key, { ...options, component, owner: this.ctx.fiber });
        return () => {
          slots.delete(key);
          counts.removedSlots++;
        };
      });
    }
  }

  class Locale extends Service {
    constructor() {
      super(ctx, 'locale');
    }
    register(namespace, values) {
      dictionaries.set(namespace, values);
      return () => {
        dictionaries.delete(namespace);
        counts.removedLocale++;
      };
    }
    bind(namespace) {
      return key => dictionaries.get(namespace).en[key];
    }
    subscribe() {
      return () => {};
    }
    getSnapshot() {
      return 'en';
    }
  }

  function provideNamespace(owner) {
    return owner.provide(
      'remote.sessionEdit',
      Object.fromEntries(
        ['inspect', 'execute'].map(name => [
          name,
          () => {
            counts.calls++;
            assert.fail(`Startup unexpectedly called ${name}`);
          },
        ]),
      ),
    );
  }

  class Remote extends Service {
    constructor() {
      super(ctx, 'remote');
    }
    $on(name, listener) {
      const listeners = remoteListeners.get(name) ?? new Set();
      remoteListeners.set(name, listeners);
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
    async $mount(contribution) {
      counts.mounts++;
      assert.equal(contribution.package, '@dshplus/session-edit');
      assert.deepEqual(
        Array.from(contribution.descriptors, entry => entry.method),
        ['inspect', 'execute'],
      );
      entered.resolve();
      await gate.promise;
      if (!lateNamespace) provideNamespace(this.ctx);
    }
  }

  new Slots();
  new Locale();
  new Remote();
  ctx.provide('uiSession', {});
  ctx.provide('sessions', sessions);
  ctx.provide('uiWorkspace', {
    openSession() {
      assert.fail('Startup must never navigate');
    },
  });

  const root = ctx.plugin(loadPlugin());
  t.after(async () => {
    gate.resolve();
    await ctx.fiber.dispose();
  });

  return {
    ctx,
    root,
    slots,
    dictionaries,
    emitRemote(name, value) {
      for (const listener of remoteListeners.get(name) ?? []) listener(value);
    },
    errors,
    counts,
    entered: entered.promise,
    release: gate.resolve,
    children: () => [...fibers].filter(fiber => fiber.parent.fiber === root.ctx.fiber),
    provideNamespace: () => provideNamespace(root.ctx),
  };
}

async function settled(f) {
  await f.root.await();
  for (const child of f.children()) await child.await();
}

function mounted(f) {
  assert.equal(f.root.state, State.ACTIVE);
  assert.equal(f.slots.size, 4);
  assert.ok(f.slots.has('conversation.chat.node:user'));
  assert.ok(f.slots.has('conversation.chat.node:steering'));
  assert.equal(f.slots.get('conversation.chat.node:user').priority, -100);
  assert.ok(f.slots.has('conversation.input.right:dshplus-session-edit.primary'));
  assert.ok(f.slots.has('shell.overlay:dshplus-session-edit.dialog'));
  assert.equal(f.dictionaries.size, 1);
  assert.equal(f.counts.calls, 0);
  assert.deepEqual(f.errors, []);
}

test('client waits for remote mount and releases its UI entries on unload', async t => {
  const f = fixture(t, { deferredMount: true });
  await f.entered;
  assert.equal(f.root.state, State.LOADING);
  assert.equal(f.slots.size, 0);
  f.release();
  await settled(f);
  mounted(f);
  await f.root.dispose();
  assert.equal(f.slots.size, 0);
  assert.equal(f.dictionaries.size, 0);
  assert.equal(f.counts.removedSlots, 4);
  assert.equal(f.counts.removedLocale, 1);
  assert.equal(f.counts.calls, 0);
});

test('late RPC namespace and namespace restart correctly suspend and remount UI', async t => {
  const f = fixture(t, { lateNamespace: true });
  await settled(f);
  assert.equal(f.children()[0].state, State.PENDING);
  assert.equal(f.slots.size, 0);
  const remove = f.provideNamespace();
  await settled(f);
  mounted(f);
  await remove();
  await settled(f);
  assert.equal(f.slots.size, 0);
  assert.equal(f.dictionaries.size, 0);
  f.provideNamespace();
  await settled(f);
  mounted(f);
  await f.root.dispose();
  assert.equal(f.counts.removedSlots, 8);
  assert.equal(f.counts.removedLocale, 2);
  assert.deepEqual(f.errors, []);
});

test('a rewrite in another window clears cached projections without an open session', async t => {
  const manager = new SessionManager({});
  t.after(() => manager.dispose());
  const f = fixture(t, { sessions: { manager, binding: () => undefined, refresh: async () => {} } });
  await settled(f);
  const summary = { sessionId: 'source', createdAt: 1, running: false, blank: false, cwd: '/tmp' };
  manager.handleSessionAdded({
    ...summary,
    projections: {
      kind: 'sequenced', asOfSeq: 100,
      values: { title: 'Old title', subagentCatalog: [{ id: 'child', mode: 'continuable' }] },
    },
  });
  const projections = manager.projectionStores.get('source');
  const title = projections.faceOf('title');
  manager.handleSessionRemoved('source');
  f.emitRemote('api-session/removed', 'source');
  assert.equal(manager.projectionStores.get('source'), projections);

  const values = { title: 'Edited title', subagentCatalog: [] };
  const added = { ...summary, projections: { kind: 'sequenced', asOfSeq: 10, values } };
  manager.handleSessionAdded(added);
  f.emitRemote('api-session/added', added);
  await new Promise(setImmediate);
  assert.equal(title.getSnapshot(), 'Edited title');
  assert.deepEqual(projections.get('subagentCatalog'), []);
  assert.equal(manager.sessions.size, 0);

  const session = manager.get('source');
  session.projections.seed({ asOfSeq: 10, values });
  assert.equal(session.projections.faceOf('title'), title);
  assert.deepEqual(session.projections.values(), values);
  assert.deepEqual(f.errors, []);
});
