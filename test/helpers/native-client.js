import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const browserReact = {
  name: 'fixture-react',
  setup(builder) {
    builder.onResolve({ filter: /^react(?:-dom|\/jsx-runtime)?$/ }, args => ({ path: args.path, namespace: 'fixture-react' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture-react' }, args => ({
      contents: args.path === 'react/jsx-runtime'
        ? 'exports.Fragment = window.React.Fragment; exports.jsx = exports.jsxs = (type, props, key) => window.React.createElement(type, {...props, key});'
        : 'module.exports = window.' + (args.path === 'react' ? 'React' : 'ReactDOM') + ';',
    }));
  },
};

function region(source, name) {
  const marker = '//#region lib/types/' + name + '.js';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'Native DSH region missing: ' + name);
  return source.slice(start + marker.length, source.indexOf('//#endregion', start));
}

async function bundle(contents, resolveDir) {
  const result = await build({
    stdin: { contents, resolveDir }, bundle: true, format: 'iife', write: false,
    outfile: 'fixture.js', loader: { '.css': 'local-css' }, plugins: [browserReact],
  });
  return {
    js: result.outputFiles.find(file => file.path.endsWith('.js')).text,
    css: result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '',
  };
}

// Read the published components rather than maintaining lookalike controls.
// Unrelated Markdown/highlighter code is omitted so its dependencies are not
// needed just to test the host's Button, InlineEditor, Menu, Modal and Tooltip.
export async function nativeClientFixture() {
  const primitivesPath = require.resolve('@deepseek-ai/dsh-client-ui-primitives');
  const source = await readFile(primitivesPath, 'utf8');
  const names = [
    'icons/shared-artwork', 'icons/index', 'Button', 'InlineEditor',
    'overlay-top-margin', 'keyboard-composition', 'focus', 'useModalLayer',
    'ShortcutKeys', 'MenuSurface', 'Menu', 'MenuGroup', 'useAnchoredMaxHeight',
    'useAnchoredPosition', 'useDismissOnOutsidePointer', 'clipboard',
    'Modal', 'input-modality', 'Tooltip', 'Toast',
  ];
  const body = names.map(name => region(source, name)).join('\n');
  const imports = source.split('\n').filter(line =>
    /^import /.test(line) && (
      /from "(?:react|react-dom|react\/jsx-runtime|clsx)"/.test(line) ||
      (line.includes('.css') && new RegExp('\\b' + line.split(' ')[1].replaceAll('$', '\\$') + '\\b').test(body))
    ),
  ).join('\n');
  const primitives = await bundle(imports + '\n' + body + `
    window.NativeUI = { Button, InlineEditor, Menu, MenuItemButton, Modal, Toast, Tooltip, writeClipboard,
      IconEditOutlineRegular, IconRefreshOutlineRegular, IconCopyOutlineRegular,
      IconCheckOutlineRegular, IconBranchOutlineRegular, IconTriangleRightFillRegular,
      IconEllipsisOutlineRegular, IconWarningOutlineRegular, IconPlusOutlineMedium };
  `, dirname(primitivesPath));

  const conversationPath = require.resolve('@deepseek-ai/dsh-client-ui-conversation/client');
  const host = await readFile(conversationPath, 'utf8');
  const cssRegion = host.match(/\/\/#region[^\n]*InputBar\.module\.css\.mjs\n([\s\S]*?)\/\/#endregion/);
  assert.ok(cssRegion, 'Native InputBar CSS region missing');
  // Exercise the unmodified host InputBar, including its real primary button.
  // Only the Lexical editor and external services are represented by fixture inputs.
  const composer = await bundle(`
    import * as react from 'react';
    import * as react_jsx_runtime from 'react/jsx-runtime';
    import clsx from 'clsx';
    const _deepseek_ai_dsh_client_ui_primitives = window.NativeUI;
    const observeControlRow = () => () => {};
    const installDraftFilePicker = () => () => {};
    const installDraftWheel = () => () => {};
    const revealDraftSelection = () => {};
    const keepDraftFocus = event => event.preventDefault();
    const ContextMeter = () => null;
    function DraftEditor({editable, ariaLabel}) {
      const ref = react.useRef(null);
      const draft = window.fixture.useInput(input => input.draft);
      react.useLayoutEffect(() => {
        if (ref.current.textContent !== draft) ref.current.textContent = draft;
      }, [draft]);
      return react.createElement('div', {
        ref, role:'textbox', 'aria-label':ariaLabel, contentEditable:editable,
        suppressContentEditableWarning:true, 'data-testid':'native-draft',
        onInput:event => window.fixture.setInput({draft:event.currentTarget.textContent}),
      });
    }
    ${region(host, 'client/locales')}
    ${region(host, 'client/input/submission-policy')}
    ${cssRegion[1]}
    ${region(host, 'client/skeleton/InputBar')}
    window.NativeInputBar = InputBar;
    window.NativeConversationLocale = en;
  `, dirname(conversationPath));
  return {
    js: primitives.js + '\n' + composer.js,
    css: primitives.css + '\n' + composer.css,
  };
}
