import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSessionReloader } from '../src/native-session.js';

const root = dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-api-session-controller'));
const { ProjectionValueStore } = await import(pathToFileURL(join(root, 'types/client/sessions/projection-store.js')));
const { MutableSessionEventSource } = await import(pathToFileURL(join(root, 'types/client/contract/events.js')));

function fixture(resync) {
  const projections = new ProjectionValueStore();
  projections.apply('title', 'Old title', 100);
  const events = new MutableSessionEventSource();
  events.replace([{ event: { seq: 99 } }, { event: { seq: 100 } }], false);
  const read = new AbortController();
  const session = {
    removed: true, projections, eventSource: events, promptError: 'old failure',
    getSnapshot: () => ({ removed: session.removed, openState: 'open' }),
    resync: resync ?? (async () => {
      events.replace([{ event: { seq: 2 } }], false);
      projections.seed({ asOfSeq: 2, values: { title: 'Edited title' } });
    }),
  };
  let refreshes = 0;
  const manager = {
    projectionStores: new Map([['source', new ProjectionValueStore()]]),
    projectionInflight: new Map([['source', { controller: read }]]),
    projectionLoads: new Map([['source', { state: 'ready' }]]),
    handleSessionAdded() {},
  };
  const sessions = { binding: () => ({ session }), manager, refresh: async () => { refreshes++; } };
  return { reload: createSessionReloader(sessions), sessions, session, manager, projections, events, read, refreshes: () => refreshes };
}

test('native projection faces and history accept the shorter replacement baseline', async () => {
  const f = fixture();
  const face = f.projections.faceOf('title');
  f.projections.seed({ asOfSeq: 2, values: { title: 'Would be ignored' } });
  assert.equal(face.getSnapshot(), 'Old title');
  await f.reload('source');
  assert.equal(f.session.removed, false);
  assert.equal(f.session.promptError, null);
  assert.equal(f.read.signal.aborted, true);
  assert.equal(f.manager.projectionStores.get('source'), f.projections);
  assert.equal(f.projections.faceOf('title'), face);
  assert.equal(face.getSnapshot(), 'Edited title');
  assert.deepEqual(f.events.getSnapshot().entries.map(entry => entry.event.seq), [2]);
  f.manager.projectionStores.get('source').apply('title', 'New live title', 3);
  assert.equal(face.getSnapshot(), 'New live title');
});

test('a second rewrite during reload obtains another baseline without duplicating submissions', async () => {
  const gate = Promise.withResolvers();
  let calls = 0;
  const f = fixture(async () => { calls++; if (calls === 1) await gate.promise; });
  const first = f.reload('source');
  await Promise.resolve();
  const second = f.reload('source', { sessionId: 'source' });
  assert.equal(first, second);
  gate.resolve();
  await second;
  assert.equal(calls, 2);
  assert.equal(f.refreshes(), 1);
});

test('a second rewrite during the final list refresh also reloads the history', async () => {
  const refreshing = Promise.withResolvers();
  const release = Promise.withResolvers();
  let calls = 0;
  const f = fixture(async () => { calls++; });
  f.sessions.refresh = async () => {
    refreshing.resolve();
    await release.promise;
  };
  const first = f.reload('source');
  await refreshing.promise;
  f.session.removed = true;
  const second = f.reload('source', { sessionId: 'source' });
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(f.session.removed, false);
});
