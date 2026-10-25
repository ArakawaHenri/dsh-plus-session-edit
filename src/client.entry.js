// Bundled into client.js. React and UI primitives are provided by DSH's loader.
import { remoteContribution } from '../remote.js';
import { createClientController } from './client-controller.js';
import { useNativePrimary, usePrimaryReplacement } from './native-composer.js';
import { createSessionReloader } from './native-session.js';
import en from '../locale/en.json';
import zh from '../locale/zh.json';
import styles from './client.css';

const dictionaries = { en, zh };
const namespace = 'dsh.sessionEdit';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function prepareContent(content, data = {}) {
  const texts = [];
  const attachments = [];
  const extraBlocks = [];
  for (const block of content || []) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'image' && isObject(block.attachment)) {
      attachments.push({ type: 'image', image: { attachment: block.attachment } });
    } else if (block.type === 'file' && isObject(block.attachment)) {
      attachments.push({ type: 'file', file: block.attachment });
    } else extraBlocks.push(block);
  }
  return {
    text: texts.join(''), attachments, extraBlocks,
    ...(data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }),
  };
}

function clock(time) {
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function mountUI(ctx, React, { createPortal }, ui) {
  const h = React.createElement;
  const {
    Button, InlineEditor, Toast, Tooltip, writeClipboard,
    IconEditOutlineRegular: EditIcon, IconRefreshOutlineRegular: RetryIcon,
    IconCopyOutlineRegular: CopyIcon, IconCheckOutlineRegular: CheckIcon,
    IconTriangleRightFillRegular: PlayIcon,
    IconWarningOutlineRegular: WarningIcon,
  } = ui;
  ctx.effect(() => ctx.locale.register(namespace, dictionaries));
  const translate = ctx.locale.bind(namespace);
  const reloadSession = createSessionReloader(ctx.sessions);
  const controller = createClientController({
    rpc: ctx.remote.sessionEdit,
    navigate: id => ctx.uiWorkspace.openSession(id),
    reloadSession,
  });
  ctx.effect(() => () => controller.dispose());
  // Native lifecycle edges also reach windows that did not initiate the edit.
  const removedSessions = new Set();
  ctx.effect(() => ctx.remote.$on('api-session/removed', sessionId => { removedSessions.add(sessionId); }));
  ctx.effect(() => ctx.remote.$on('api-session/added', summary => {
    const session = ctx.sessions.binding(summary.sessionId)?.session;
    if (removedSessions.delete(summary.sessionId) || session?.getSnapshot().removed) {
      void reloadSession(summary.sessionId, summary)
        .then(() => {
          if (controller.getSnapshot().sessions[summary.sessionId]) {
            return controller.loadSession(summary.sessionId, true).catch(() => {});
          }
        })
        .catch(error => controller.reportRefreshError(summary.sessionId, error));
    }
  }));

  function useTranslation() {
    React.useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot());
    return translate;
  }

  function useState(selector) {
    return React.useSyncExternalStore(
      controller.subscribe,
      selector ? () => selector(controller.getSnapshot()) : controller.getSnapshot,
    );
  }

  function explain(error, t) {
    const code = String(error?.code || error || '').split('/').at(-1);
    const key = 'error.' + code;
    return Object.hasOwn(dictionaries.en, key)
      ? t(key)
      : typeof error === 'string' ? error : error?.message || t('error.generic');
  }

  function canExecute(props) {
    return typeof props.useRemoteAccess === 'function' && props.useRemoteAccess('sessionEdit/execute');
  }

  function action(label, Icon, onClick, { unavailable = false, busy = false, hint = label } = {}) {
    return h(Tooltip, { label: hint, side: 'bottom', portal: true },
      h('button', {
        type: 'button', className: 'dsh-se-action', 'aria-label': label,
        'aria-disabled': unavailable || busy || undefined, disabled: busy,
        onClick: unavailable || busy ? undefined : onClick,
      }, h(Icon, { size: 16 })),
    );
  }

  function MessageEditor({ current }) {
    const t = useTranslation();
    const ref = React.useRef(null);
    React.useEffect(() => {
      if (!current.loading) ref.current?.querySelector('textarea')?.focus();
    }, [current.eventSeq, current.loading]);
    return h('div', {
      className: 'dsh-se-editor', ref, 'data-testid': 'session-edit-inline',
    },
      current.error && h('p', { className: 'dsh-se-error', role: 'alert' }, explain(current.error, t)),
      current.loading && h('p', { className: 'dsh-se-muted', role: 'status' }, t('loading')),
      h('fieldset', { className: 'dsh-se-editor-field', disabled: current.busy || current.loading },
        h(InlineEditor, {
          value: current.text, label: t('textLabel'), className: 'dsh-se-editor-input',
          onChange: controller.setText, onSave: () => void controller.submitEdit(), onCancel: controller.close,
        }),
      ),
      h('div', { className: 'dsh-se-editor-actions' },
        h(Button, { size: 'sm', onClick: controller.close }, t(current.busy ? 'close' : 'cancel')),
        h(Button, {
          size: 'sm', variant: 'primary', icon: h(RetryIcon),
          disabled: current.busy || current.loading || !current.messageId || !current.text?.trim(),
          onClick: () => void controller.submitEdit(), 'data-testid': 'execute-action',
        }, t(current.busy ? 'sending' : 'confirmEdit')),
      ),
    );
  }

  function UserMessage(props) {
    const t = useTranslation();
    const allowed = canExecute(props);
    const data = props.node.data;
    const state = useState();
    const current = state.panel;
    const editing = current?.sessionId === props.sessionId && current.eventSeq === data.seq;
    React.useEffect(() => () => {
      const panel = controller.getSnapshot().panel;
      if (panel?.sessionId === props.sessionId && panel.eventSeq === data.seq) {
        controller.close();
      }
    }, [props.sessionId, data.seq]);
    const [copyState, setCopyState] = React.useState(null);
    const copyTimer = React.useRef(null);
    React.useEffect(() => () => clearTimeout(copyTimer.current), []);
    const prepared = React.useMemo(() => prepareContent(data.content, data), [data.content, data.referenceLabels]);
    const facts = React.useMemo(() => ({
      ...(data.referenceLabels === undefined ? {} : { sessionLabels: data.referenceLabels }),
      ...(data.skillNames === undefined ? {} : { skillNames: data.skillNames }),
    }), [data.referenceLabels, data.skillNames]);
    const supported = Array.isArray(data.content) && data.content.length > 0 &&
      prepared.extraBlocks.length === 0 &&
      (Boolean(prepared.text.trim()) || prepared.attachments.length > 0);
    const session = state.sessions[props.sessionId]?.value;
    const owned = session?.ordinary === false;
    const archived = session?.archived === true;
    const tooLong = supported && prepared.text.length > 131072;
    const editable = data.source?.kind === 'user' && Number.isSafeInteger(data.seq) &&
      data.seq >= 0 && supported && !owned && !archived && !tooLong;
    const reason = owned ? t('error.owned-session') : archived ? t('error.archived') : tooLong ? t('error.message-too-large') : t('plainTextOnly');
    const target = {
      sessionId: props.sessionId, eventSeq: data.seq, messageId: data.messageId, text: prepared.text, time: data.time,
    };
    const copy = async () => {
      const copied = await writeClipboard(prepared.text).catch(() => false);
      setCopyState(copied ? 'copied' : 'copyFailed');
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyState(null), 1500);
    };
    return h('div', { className: 'dsh-se-row', 'data-session-edit-message': data.seq },
      editing
        ? h(React.Fragment, null,
            prepared.attachments.length > 0 && props.renderFactorySlot('conversation.chat.user.content', {
              content: { ...prepared, text: '' }, loadImage: props.loadImage, facts, interactive: false,
            }),
            h(MessageEditor, { current }),
          )
        : props.renderFactorySlot('conversation.chat.user.content', {
            content: prepared, loadImage: props.loadImage, facts, interactive: true,
          }),
      !editing && h('div', { className: 'dsh-se-row-actions' },
        Number.isFinite(data.time) && h('time', { dateTime: new Date(data.time).toISOString() }, clock(data.time)),
        action(t(copyState || 'copy'), copyState === 'copied' ? CheckIcon : CopyIcon, () => void copy()),
        allowed && action(t('editTitle'), EditIcon, () => void controller.openEdit(target), {
          unavailable: !editable, hint: editable ? t('editTitle') : reason,
          busy: controller.isBusy(props.sessionId, 'edit', data.seq),
        }),
        allowed && action(t('retryTitle'), RetryIcon, () => void controller.retryMessage(target), {
          unavailable: !editable, hint: editable ? t('retryTitle') : reason,
          busy: controller.isBusy(props.sessionId, 'retry', data.seq),
        }),
      ),
    );
  }

  function ComposerContinue(props) {
    const t = useTranslation();
    const allowed = canExecute(props);
    const running = props.useSession(s => s.running);
    const openState = props.useSession(s => s.openState);
    const removed = props.useSession(s => s.removed);
    const input = props.useInput(s => s);
    const entry = useState(s => s.sessions[props.sessionId]);
    const busy = useState(() => controller.isBusy(props.sessionId, 'continue'));
    const marker = React.useRef(null);
    const anchor = useNativePrimary(React, marker, props.sessionId);
    React.useEffect(() => {
      if (allowed && props.sessionId && !running) void controller.loadSession(props.sessionId, true).catch(() => {});
    }, [props.sessionId, allowed, running, openState]);
    const facts = entry?.value;
    const available = allowed && !removed && !running && input?.phase === 'plain' &&
      !input.draft.trim() && input.attachmentIds.length === 0 && input.queue.length === 0 &&
      facts?.ordinary && !facts.archived && facts.status !== 'running' && facts.continuation.available;
    const replace = Boolean(available && anchor?.editable && anchor.disabled);
    usePrimaryReplacement(React, anchor, replace);
    const button = h(Tooltip, { label: t('confirmContinue'), side: 'top', portal: true },
      h('button', {
        type: 'button', className: anchor?.className || 'dsh-se-primary',
        'aria-label': t('confirmContinue'), 'data-testid': 'session-edit-resume',
        disabled: busy || entry?.loading,
        onMouseDown: event => event.preventDefault(),
        onClick: () => void controller.continueSession(props.sessionId),
      }, h(PlayIcon, { size: 20 })),
    );
    return h(React.Fragment, null,
      h('span', { ref: marker, hidden: true, 'data-session-edit-control': true }),
      replace && createPortal(h('span', { className: 'dsh-se-primary-seat', 'data-session-edit-control': true }, button), anchor.parent),
      available && !anchor && h('span', { 'data-session-edit-control': true }, button),
    );
  }

  function Overlay() {
    const t = useTranslation();
    const state = useState();
    const notice = state.notice;
    return h(React.Fragment, null,
      h('style', { 'data-session-edit-styles': true }, styles),
      notice && h(Toast, {
        key: state.revision, text: notice.code === 'session-edit/navigation-failed' ? t('navigationFailed') : explain(notice, t),
        icon: h(WarningIcon), holdMs: 8000, onDone: controller.clearNotice,
        actions: notice.sessionId ? [{ label: t('openConversation'), onClick: () => {
          controller.clearNotice(); void controller.openResult({ sourceSessionId: notice.sessionId, historyUpdated: notice.historyUpdated });
        } }] : undefined,
      }),
    );
  }

  const register = (name, options, component) => ctx.slots.inject(name, () => ctx.slots.register({ name, ...options }, component));
  register('shell.overlay', { id: 'dshplus-session-edit.dialog', order: 120 }, Overlay);
  for (const key of ['user', 'steering']) register('conversation.chat.node', { key, priority: -100 }, UserMessage);
  register('conversation.input.right', { id: 'dshplus-session-edit.primary', order: 100 }, ComposerContinue);
}

window.__ModuleLoader__.load({
  id: '@dshplus/session-edit',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const ui = require('@deepseek-ai/dsh-client-ui-primitives');
    return {
      inject: ['remote'],
      async apply(ctx) {
        await ctx.remote.$mount(remoteContribution());
        ctx.inject(['slots', 'locale', 'remote', 'remote.sessionEdit', 'sessions', 'uiWorkspace'], uiCtx => mountUI(uiCtx, React, ReactDOM, ui));
      },
    };
  },
});
