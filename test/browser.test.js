import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { buildClientSource } from '../scripts/build-client.js';
import { nativeClientFixture } from './helpers/native-client.js';

const require = createRequire(import.meta.url);
const client = await buildClientSource();
const native = await nativeClientFixture();
const react = await readFile(
  join(dirname(require.resolve('react/package.json')), 'umd/react.development.js'),
);
const reactDom = await readFile(
  join(dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'),
);

let browser;
before(async () => {
  const candidates = [
    process.env.DSH_SESSION_EDIT_BROWSER,
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const executablePath = candidates.find(path => existsSync(path));
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
});
after(async () => {
  await browser?.close();
});

function bootFixture() {
  const React = window.React;
  const h = React.createElement;
  const fixture = (window.fixture = {
    slots: new Map(),
    navigation: [],
    factories: [],
    rpcCalls: [],
    disposers: [],
    session: { running: false, openState: 'ready', removed: false, subagent: null },
    input: { draft: '', phase: 'plain', attachmentIds: [], queue: [] },
    sent: [], stops: 0, extension: true, inspectReplies: 0, reloads: [], remoteListeners: new Map(),
    listeners: new Set(),
  });
  window.__ModuleLoader__ = {
    load: entry => {
      fixture.entry = entry;
    },
  };
  fixture.start = async () => {
    let dictionaries;
    const services = new Map();
    const rpc = Object.fromEntries(
      ['inspect', 'execute'].map(method => [
        method,
        async request => {
          fixture.rpcCalls.push({ method, request });
          const response = await fetch(`/fixture/${method}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
          });
          const reply = await response.json();
          if (method === 'inspect') fixture.inspectReplies++;
          if (method === 'execute' && request.action === 'continue' && reply.ok) fixture.setRunning(true);
          if (method === 'execute' && reply.ok && reply.value.historyUpdated) fixture.publishRewrite();
          return reply;
        },
      ]),
    );
    services.set('slots', {
      inject: (_name, callback) => {
        const dispose = callback();
        fixture.disposers.push(dispose);
        return dispose;
      },
      register: (options, component) => {
        const key = `${options.name}:${options.key || options.id || ''}`;
        fixture.slots.set(key, { options, component });
        return () => fixture.slots.delete(key);
      },
    });
    services.set('locale', {
      register: (_namespace, values) => {
        dictionaries = values;
        return () => {};
      },
      bind: () => key => dictionaries.en[key],
      subscribe: () => () => {},
      getSnapshot: () => 'en',
    });
    services.set('remote', {
      $mount: async () => {},
      $on(name, listener) {
        const listeners = fixture.remoteListeners.get(name) ?? new Set();
        fixture.remoteListeners.set(name, listeners);
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    services.set('remote.sessionEdit', rpc);
    services.set('uiWorkspace', {
      openSession: id => {
        fixture.navigation.push(id);
      },
    });
    services.set('uiSession', {});
    const nativeSession = {
      removed: false,
      projections: { clear() {} },
      getSnapshot: () => ({ ...fixture.session, removed: nativeSession.removed }),
      async resync() {
        fixture.reloads.push('source');
        const selected = await (await fetch('/native/history')).json();
        message.data = { ...message.data, messageId: selected.messageId, content: [{ type: 'text', text: selected.text }] };
        fixture.session = { ...fixture.session, removed: false };
        fixture.root.render(h(App));
        for (const listener of fixture.listeners) listener();
      },
    };
    const manager = {
      projectionStores: new Map([['source', nativeSession.projections]]),
      projectionInflight: new Map(), projectionLoads: new Map(), handleSessionAdded() {},
    };
    services.set('sessions', { binding: id => id === 'source' ? { session: nativeSession } : undefined, manager, refresh: async () => {} });
    fixture.publishRewrite = () => {
      nativeSession.removed = true;
      fixture.session = { ...fixture.session, removed: true, running: true };
      manager.projectionStores.delete('source');
      for (const listener of fixture.listeners) listener();
      for (const listener of fixture.remoteListeners.get('api-session/added') ?? []) listener({ sessionId: 'source', running: true });
    };

    function context(names) {
      const ctx = {
        effect(callback) {
          const cleanup = callback();
          if (typeof cleanup === 'function') fixture.disposers.push(cleanup);
          return cleanup;
        },
        inject(dependencies, callback) {
          if (dependencies.every(name => services.has(name))) {
            return callback(context(dependencies));
          }
        },
      };
      for (const name of names) {
        if (!name.includes('.')) {
          Object.defineProperty(ctx, name, {
            get: () =>
              name === 'remote'
                ? { ...services.get('remote'), sessionEdit: services.get('remote.sessionEdit') }
                : services.get(name),
          });
        }
      }
      return ctx;
    }

    const plugin = fixture.entry.factory(name => {
      if (name === 'react') return React;
      if (name === 'react-dom') return window.ReactDOM;
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return window.NativeUI;
      throw new Error(`Unexpected module: ${name}`);
    });
    await plugin.apply(context(plugin.inject));

    const get = key => fixture.slots.get(key).component;
    const User = get('conversation.chat.node:user');
    const Primary = get('conversation.input.right:dshplus-session-edit.primary');
    const Overlay = get('shell.overlay:dshplus-session-edit.dialog');
    const useSession = selector =>
      React.useSyncExternalStore(
        listener => {
          fixture.listeners.add(listener);
          return () => fixture.listeners.delete(listener);
        },
        () => selector(fixture.session),
      );
    const useRemoteAccess = () => true;
    const useInput = selector => React.useSyncExternalStore(
      listener => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); },
      () => selector(fixture.input),
    );
    fixture.useInput = useInput;
    fixture.setInput = patch => {
      fixture.input = { ...fixture.input, ...patch };
      for (const listener of fixture.listeners) listener();
    };
    const common = { sessionId: 'source', useSession, useInput, useRemoteAccess };
    const empty = {};
    const keyboard = {
      editor: null,
      submit(mode) {
        fixture.sent.push({ mode, text: fixture.input.draft, attachments: fixture.input.attachmentIds });
        fixture.setInput({ draft: '', attachmentIds: [] });
        fixture.setRunning(true);
      },
    };
    const message = {
      kind: 'user',
      data: {
        seq: 7,
        time: 1760000000000,
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Original selected input' }],
        referenceLabels: ['Source A'],
        skillNames: ['sample'],
      },
    };
    function factory(name, props) {
      fixture.factories.push({
        name,
        content: props.content,
        facts: props.facts,
        interactive: props.interactive,
      });
      return h(
        'section',
        { 'data-testid': 'native-user-factory' },
        props.content.text,
        ...props.content.attachments.map((attachment, index) =>
          h('span', { key: index, 'data-attachment-type': attachment.type }, attachment.type),
        ),
        ...props.content.extraBlocks.map((block, index) =>
          h('code', { key: index }, JSON.stringify(block)),
        ),
      );
    }
    function App() {
      return h(
        'main',
        null,
        fixture.extension && h(User, {
          sessionId: 'source',
          node: message,
          useSession,
          useRemoteAccess,
          renderFactorySlot: factory,
          loadImage: async () => null,
        }),
        h(window.NativeInputBar, {
          ...common, variant: 'composer', keyboard, inputActions: { pruneAttachments() {} },
          disabled: fixture.locked,
          stop: () => { fixture.stops++; fixture.setRunning(false); },
          resolveDraftAttachments: ids => ids.map(id => ({ id, kind: 'image' })),
          t: key => window.NativeConversationLocale[key] || key,
          useBusyEnter: select => select('queue'),
          useFileUploads: select => select(empty), useNotices: select => select(null),
          useLexicon: select => select(empty), useMenuLauncher: select => select(null),
          useStopShortcut: select => select([]),
          useProjection: (_name, select) => select ? select(undefined) : undefined,
          renderSlot: name => !fixture.extension ? null : name === 'conversation.input.right'
            ? h(Primary, common) : null,
        }),
        fixture.extension && h(Overlay),
      );
    }
    fixture.root = window.ReactDOM.createRoot(document.getElementById('root'));
    fixture.root.render(h(App));
    fixture.setContent = content => {
      message.data = { ...message.data, content };
      fixture.root.render(h(App));
    };
    fixture.setRunning = running => {
      fixture.session = { ...fixture.session, running };
      for (const listener of fixture.listeners) listener();
    };
    fixture.setLocked = locked => { fixture.locked = locked; fixture.root.render(h(App)); };
    fixture.unload = async () => {
      fixture.extension = false;
      fixture.root.render(h(App));
      await new Promise(requestAnimationFrame);
      for (const dispose of fixture.disposers.reverse()) dispose?.();
    };
    fixture.ready = true;
  };
}

async function fixture(t, options = {}) {
  const state = {
    calls: [],
    continuationAvailable: true,
    reason: undefined,
    ...options,
  };
  const facts = {
    sessionId: 'source',
    status: 'idle',
    archived: false,
    ordinary: true,
    headSeq: 80,
    continuation: {
      available: state.continuationAvailable,
    },
  };
  const selected = {
    eventSeq: 7,
    messageId: 'message-7',
    text: 'Original selected input',
    time: 1760000000000,
    editable: true,
  };
  const assets = {
    '/react.js': react,
    '/react-dom.js': reactDom,
    '/client.js': client,
    '/native.js': native.js,
    '/native.css': native.css,
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (assets[url.pathname]) {
        response.setHeader('content-type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
        response.end(assets[url.pathname]);
        return;
      }
      if (url.pathname === '/favicon.ico') {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (url.pathname === '/native/history') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(selected));
        return;
      }
      if (url.pathname === '/') {
        response.setHeader('content-type', 'text/html');
        response.end(
          `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/native.css"><style>
          :root{--dsw-font-family:Arial,sans-serif;--dsw-font-xs-13:13px/20px Arial;--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#666;--dsw-alias-label-tertiary:#888;--dsw-alias-label-caption:#888;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#fff;--dsw-alias-border-l2:#ddd;--dsw-alias-border-l3:#ddd;--dsw-alias-border-l4:#eee;--dsw-alias-interactive-bg-hover:#f1f1f1;--dsw-alias-button-primary-fill:#222;--dsw-alias-button-info-fill:#222;--dsw-alias-state-error-primary:#b23;--dsw-alias-state-business-primary:#5277df;--dsw-specific-input-major:#fafafa;--dsw-specific-menu:#fff;--dsw-radius-sm:6px;--dsw-radius-md:10px;--dsw-radius-lg:12px;--dsw-radius-panel:16px;--dsh-composer-card-max-width:800px;--dsh-composer-side-clearance:0px}
          body{font:14px/1.6 Arial;padding:20px}main{max-width:800px;margin:auto}.dsh-se-row{margin:24px 0}[data-testid=native-user-factory]{background:#f4f4f4;border-radius:16px;padding:12px 16px}[data-testid=native-draft]{min-height:64px;padding:8px 14px}
          </style></head><body><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script src="/native.js"></script><script>(${bootFixture.toString()})();</script><script src="/client.js"></script><script>fixture.start();</script></body></html>`,
        );
        return;
      }
      const method = url.pathname.slice('/fixture/'.length);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      state.calls.push({ method, input });
      let value;
      if (method === 'inspect') {
        value =
          input.eventSeq !== undefined
            ? { ...facts, message: selected }
            : facts;
      }
      if (method === 'execute') {
        if (state.rejectExecute) {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ ok: false, error: state.rejectExecute }));
          return;
        }
        if (state.executeGate) await state.executeGate.promise;
        if (input.action === 'continue') {
          facts.status = 'running';
          value = { sourceSessionId: 'source' };
        } else {
          if (input.action === 'edit') selected.text = input.replacementText;
          selected.messageId = 'updated-message-7';
          facts.status = 'running';
          value = { sourceSessionId: 'source', historyUpdated: true };
        }
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, value }));
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    state.executeGate?.resolve();
    await context.close();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.fixture?.ready);
  await page.getByTestId('native-user-factory').waitFor();
  return { page, state, facts, selected, origin };
}

test('browser: native inline editing submits once without opening a dialog', async t => {
  const { page, state } = await fixture(t);
  const body = await page.evaluate(() => fixture.factories.at(-1));
  assert.equal(body.name, 'conversation.chat.user.content');
  assert.deepEqual(body.facts, { sessionLabels: ['Source A'], skillNames: ['sample'] });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByTestId('execute-action').waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.locator('[data-session-edit-message="7"] textarea').count(), 1);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Changed message\nwith two lines');
  await page.getByTestId('execute-action').evaluate(button => {
    button.click();
    button.click();
  });
  await page.waitForFunction(() => fixture.navigation.length === 1);
  const writes = state.calls.filter(call => call.method === 'execute');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].input, {
    sessionId: 'source',
    action: 'edit',
    eventSeq: 7,
    messageId: 'message-7',
    replacementText: 'Changed message\nwith two lines',
  });
  assert.ok(state.calls.some(call => call.method === 'inspect' && call.input.eventSeq === 7));
  assert.equal(await page.getByTestId('session-edit-dialog').count(), 0);
  assert.equal(await page.getByTestId('native-user-factory').textContent(), 'Changed message\nwith two lines');
  assert.deepEqual(await page.evaluate(() => fixture.navigation), ['source']);
});

test('browser: one-click retry works while the session is running', async t => {
  const { page, state, facts } = await fixture(t);
  facts.status = 'running';
  await page.evaluate(() => fixture.setRunning(true));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction(() => fixture.navigation.length === 1);
  const command = state.calls.find(call => call.method === 'execute').input;
  assert.deepEqual(command, {
    sessionId: 'source',
    action: 'retry',
    eventSeq: 7,
    messageId: 'message-7',
  });
});

test('browser: available continuation is one click and never adds prompt text', async t => {
  const { page, state } = await fixture(t);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForFunction(() => fixture.session.running);
  assert.deepEqual(await page.evaluate(() => fixture.navigation), []);
  const command = state.calls.find(call => call.method === 'execute').input;
  assert.deepEqual(command, {
    sessionId: 'source',
    action: 'continue',
  });
});

test('browser: a forbidden response shows an alert banner', async t => {
  const { page } = await fixture(t, {
    rejectExecute: { code: 'session-edit/forbidden', message: 'Only owner' },
  });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Permission denied' }).waitFor();
});

test('browser: image and file attachments remain editable while unsupported blocks stay preserved by the native Factory', async t => {
  const { page } = await fixture(t);
  await page.evaluate(() =>
    fixture.setContent([
      { type: 'text', text: 'With attachment' },
      { type: 'image', attachment: { id: 'image-1', name: 'image.png' } },
      { type: 'file', attachment: { id: 'file-1', name: 'file.txt', bytes: 12 } },
    ]),
  );
  await page.locator('[data-attachment-type="image"]').waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Edit', exact: true }).getAttribute('aria-disabled'),
    null,
  );
  assert.equal(
    await page.getByRole('button', { name: 'Retry', exact: true }).getAttribute('aria-disabled'),
    null,
  );
  assert.deepEqual(await page.evaluate(() => fixture.factories.at(-1).content.attachments), [
    { type: 'image', image: { attachment: { id: 'image-1', name: 'image.png' } } },
    { type: 'file', file: { id: 'file-1', name: 'file.txt', bytes: 12 } },
  ]);

  await page.evaluate(() =>
    fixture.setContent([
      { type: 'text', text: 'With custom block' },
      { type: 'custom-block', payload: 1 },
    ]),
  );
  assert.equal(
    await page.getByRole('button', { name: 'Edit', exact: true }).getAttribute('aria-disabled'),
    'true',
  );
  assert.equal(
    await page.getByRole('button', { name: 'Retry', exact: true }).getAttribute('aria-disabled'),
    'true',
  );
  assert.deepEqual(await page.evaluate(() => fixture.factories.at(-1).content.extraBlocks), [
    { type: 'custom-block', payload: 1 },
  ]);
});

test('browser: the native primary keeps text, attachment, stop and busy-queue behavior', async t => {
  const { page, state } = await fixture(t);
  const resume = page.getByTestId('session-edit-resume');
  await resume.waitFor();
  const original = await page.locator('[data-session-edit-suppressed]').elementHandle();
  assert.equal(await resume.getAttribute('class'), await original.getAttribute('class'));
  const draft = page.getByTestId('native-draft');
  await draft.fill('A normal message');
  await page.waitForFunction(() => !document.querySelector('[data-session-edit-suppressed]'));
  assert.equal(await resume.count(), 0);
  assert.equal(await original.isVisible(), true);
  assert.equal(await original.isDisabled(), false);
  await draft.fill('  ');
  await resume.waitFor();
  await page.evaluate(() => fixture.setInput({ draft: '', attachmentIds: ['image-1'] }));
  await page.waitForFunction(() => !document.querySelector('[data-session-edit-suppressed]'));
  await original.click();
  await page.waitForFunction(() => fixture.session.running);
  assert.deepEqual(await page.evaluate(() => fixture.sent[0].attachments), ['image-1']);
  await draft.fill('Follow up while running');
  await original.click();
  assert.equal(await page.evaluate(() => fixture.sent[1].mode), 'queue');
  await original.click();
  assert.equal(await page.evaluate(() => fixture.stops), 1);
  await resume.waitFor();
  assert.equal(state.calls.filter(call => call.method === 'execute').length, 0);
});

test('browser: the native inline editor handles IME, newline, cancel and draft restoration', async t => {
  const { page, state } = await fixture(t);
  await page.getByTestId('native-draft').fill('Unsent composer draft');
  const edit = page.getByRole('button', { name: 'Edit', exact: true });
  await edit.click();
  const field = page.getByRole('textbox', { name: 'Message', exact: true });
  await field.fill('First line');
  await field.press('End');
  await field.press('Shift+Enter');
  await field.press('a');
  await field.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
  assert.equal(state.calls.filter(call => call.method === 'execute').length, 0);
  assert.equal(await field.inputValue(), 'First line\na');
  await field.press('Escape');
  assert.equal(await page.getByTestId('session-edit-inline').count(), 0);
  await edit.click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="execute-action"]').disabled);
  assert.equal(await field.inputValue(), 'First line\na');
  await field.press('Enter');
  await page.waitForFunction(() => fixture.navigation.length === 1);
  assert.equal(state.calls.filter(call => call.method === 'execute').length, 1);
  assert.equal(await page.getByTestId('native-draft').textContent(), 'Unsent composer draft');
});

test('browser: failed inline edits retain their text and report the error beside the message', async t => {
  const { page, state } = await fixture(t, {
    rejectExecute: { code: 'session-edit/host-error', message: 'Failed' },
  });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Message', exact: true });
  await field.fill('Keep this edited text');
  await page.getByTestId('execute-action').click();
  await page.getByTestId('session-edit-inline').getByRole('alert').waitFor();
  assert.equal(await field.inputValue(), 'Keep this edited text');
  assert.equal(await field.isEditable(), true);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(state.calls.filter(call => call.method === 'execute').length, 1);
});

test('browser: continuation failure surfaces a toast alert', async t => {
  const { page, state } = await fixture(t, {
    rejectExecute: { code: 'session-edit/host-error', message: 'Failed' },
  });
  await page.getByTestId('session-edit-resume').click();
  await page.getByRole('alert').filter({ hasText: 'Host error' }).waitFor();
  assert.equal(state.calls.filter(call => call.method === 'execute').length, 1);
  assert.deepEqual(await page.evaluate(() => fixture.navigation), []);
});

test('browser: blocked composers, claimed commands and pending queues keep their native primary', async t => {
  const { page } = await fixture(t);
  const resume = page.getByTestId('session-edit-resume');
  await resume.waitFor();
  await page.evaluate(() => fixture.setLocked(true));
  await page.waitForFunction(() => !document.querySelector('[data-session-edit-suppressed]'));
  assert.equal(await resume.count(), 0);
  await page.evaluate(() => fixture.setLocked(false));
  await resume.waitFor();
  await page.evaluate(() => fixture.setInput({ phase: 'claimed', claim: { token: '/goal', name: 'goal' } }));
  await page.waitForFunction(() => !document.querySelector('[data-session-edit-suppressed]'));
  assert.equal(await resume.count(), 0);
  await page.evaluate(() => fixture.setInput({ phase: 'plain', queue: [{}] }));
  assert.equal(await resume.count(), 0);
});

test('browser: unloading restores the original button and retains the native editor', async t => {
  const { page } = await fixture(t);
  await page.getByTestId('session-edit-resume').waitFor();
  const original = await page.locator('[data-session-edit-suppressed]').elementHandle();
  const editor = await page.getByTestId('native-draft').elementHandle();
  await page.evaluate(() => fixture.unload());
  assert.equal(await original.isVisible(), true);
  assert.equal(await original.isDisabled(), true);
  assert.equal(await editor.evaluate(node => node.isConnected), true);
  assert.equal(await page.locator('[data-session-edit-suppressed]').count(), 0);
  assert.equal(await page.getByTestId('session-edit-resume').count(), 0);
  await editor.fill('Still the native editor');
  await original.click();
  assert.equal(await page.evaluate(() => fixture.sent[0].text), 'Still the native editor');
});

test('browser: completed sessions do not show a resume button', async t => {
  const { page } = await fixture(t, { continuationAvailable: false, reason: 'not-resumable' });
  await page.waitForFunction(() => fixture.inspectReplies > 0);
  assert.equal(await page.getByTestId('session-edit-resume').count(), 0);
});

test('browser: a rewrite from another window reloads the existing conversation', async t => {
  const { page, selected } = await fixture(t);
  await page.getByTestId('native-draft').fill('My unsent composer draft');
  selected.text = 'Edited in another window';
  selected.messageId = 'new-message-id';
  await page.evaluate(() => fixture.publishRewrite());
  await page.waitForFunction(() => document.querySelector('[data-testid="native-user-factory"]')?.textContent === 'Edited in another window');
  assert.equal(await page.getByTestId('native-draft').textContent(), 'My unsent composer draft');
  assert.deepEqual(await page.evaluate(() => fixture.navigation), []);
  assert.ok(await page.evaluate(() => fixture.reloads.length > 0));
});
