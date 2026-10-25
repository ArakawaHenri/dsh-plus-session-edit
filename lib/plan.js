import { interruptedTurnClosers } from '@deepseek-ai/dsh-session';
import { foldSurface } from '@deepseek-ai/dsh-session/surface';
import { fail } from './errors.js';

export const isHuman = event =>
  event.type === 'user/message' &&
  event.surfaceOp === 'append' &&
  event.data?.role === 'user' &&
  event.data.source?.kind === 'user';

export const textOf = message =>
  message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

export const isAttachmentBlock = block =>
  (block?.type === 'image' || block?.type === 'file') &&
  block.attachment !== null &&
  typeof block.attachment === 'object' &&
  !Array.isArray(block.attachment);

export const isSupportedContent = message =>
  Array.isArray(message?.content) &&
  message.content.length > 0 &&
  message.content.every(
    block => (block?.type === 'text' && typeof block.text === 'string') || isAttachmentBlock(block),
  );

export function replaceMessageText(content, text) {
  const next = [];
  let placed = false;
  for (const block of content) {
    if (block.type === 'text') {
      if (!placed) {
        next.push({ type: 'text', text });
        placed = true;
      }
    } else {
      next.push(structuredClone(block));
    }
  }
  if (!placed) next.push({ type: 'text', text });
  return next;
}

export function foldInbox(events) {
  const queues = { 'next-turn': [], 'next-step': [] };
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue;
    const { target, start, removedCount = 0, inserted = [] } = event.data;
    const queue = queues[target];
    if (
      !queue ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start > queue.length ||
      !Number.isSafeInteger(removedCount) ||
      removedCount < 0 ||
      start + removedCount > queue.length ||
      !Array.isArray(inserted)
    ) {
      fail('invalid-history', 'The session contains an invalid inbox history.');
    }
    queues[target] = queue.toSpliced(start, removedCount, ...inserted);
  }
  return queues;
}

export function messageOf(event) {
  return event?.type === 'user/message' ? event.data : event?.data?.message;
}

export function surfaceEvents(events, projections = []) {
  let nodes;
  try {
    ({ nodes } = foldSurface(events, projections));
  } catch (error) {
    fail('invalid-history', error?.message || 'The session history could not be validated.');
  }
  return nodes
    .map(seq => events[seq])
    .filter(event => messageOf(event)?.content?.length > 0);
}

function headerModelConfig(header) {
  const config = header?.config;
  if (!config || typeof config !== 'object') return config;
  if (header?.adapterDefaults?.reasoningEffort === true && config.reasoningEffort !== undefined) {
    const { reasoningEffort: _, ...rest } = config;
    return rest;
  }
  return config;
}

export function modelOf(events, fallback = {}) {
  let lastUsed = fallback;
  let pending;
  for (const event of events) {
    if (event.type === 'model/selection') pending = event.data;
    if (event.type === 'request/header') {
      const header = event.data?.header;
      lastUsed = headerModelConfig(header);
      // An older request can finish preparation after a new model was selected.
      // Like the host, consume that selection only when a matching request uses it.
      if (sameModelSelection(pending, header?.config)) pending = undefined;
    }
  }
  return pending ?? lastUsed ?? {};
}

export function continuationPolicy(events, { projections } = {}) {
  const lastEnd = events.findLast(event => event.type === 'turn/end');
  const lastStart = events.findLast(event => event.type === 'turn/start');
  const reason = lastEnd?.data.reason;
  const unfinished =
    reason?.kind === 'error' ||
    reason?.kind === 'max-tokens' ||
    (reason?.kind === 'aborted' && reason.reason?.kind === 'user');
  if (!unfinished || (lastStart && lastStart.seq > lastEnd.seq)) {
    return { available: false };
  }

  const queues = foldInbox(events);
  if (queues['next-turn'].length || queues['next-step'].length) {
    return { available: false };
  }

  const surface = surfaceEvents(events, projections);
  const conversationSurface = surface.filter(event => {
    const role = messageOf(event)?.role;
    return role !== 'system' && role !== 'developer';
  });
  const tail = messageOf(conversationSurface.at(-1));
  if (!tail) return { available: false };

  const turnStartSeq = lastStart?.seq ?? -1;
  const lastClaim = events.findLast(
    event =>
      event.seq > turnStartSeq &&
      event.type === 'agent/inbox/spliced' &&
      event.data.removedCount > 0 &&
      event.data.outcome !== 'canceled',
  );
  const unadmittedClaim =
    lastClaim !== undefined &&
    !events.some(
      event =>
        event.seq > lastClaim.seq &&
        ['user/message', 'assistant/message', 'assistant/attempt'].includes(event.type),
    );
  if (unadmittedClaim) return { available: false };

  const pendingTools = new Set();
  for (const event of surface) {
    const message = messageOf(event);
    if (message?.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool-call') pendingTools.add(block.id);
      }
    }
    if (message?.role === 'tool') {
      pendingTools.delete(message.toolCallId ?? message.source?.callId);
    }
  }
  if (pendingTools.size) return { available: false };
  if (!['user', 'tool', 'assistant'].includes(tail.role)) {
    return { available: false };
  }
  if (
    tail.source?.replayState?.response?.kind === 'pi-ai' &&
    ['aborted', 'error'].includes(tail.source.replayState.response.stopReason)
  ) {
    return { available: false };
  }

  return { available: true };
}

export function planOperation(request, snapshot, options = {}) {
  const { events, header } = snapshot;
  if (!snapshot.ordinary) {
    fail('owned-session', 'This session is controlled by another agent.');
  }
  const common = {
    sessionId: header.id,
    action: request.action,
    headSeq: events.at(-1)?.seq ?? -1,
  };

  if (request.action === 'continue') {
    if (snapshot.status === 'running') {
      fail('source-running', 'Wait for this session to finish, or stop it first.');
    }
    if (snapshot.archived) {
      fail('archived', 'Restore this session to its workspace before continuing it.');
    }
    if (!continuationPolicy(events, options).available) {
      fail('continuation-unsupported', 'This session cannot continue directly.');
    }
    return common;
  }

  if (snapshot.archived) {
    fail('archived', 'Restore this session to its workspace before regenerating it.');
  }
  if (!header.cwd) fail('workspace-required', 'The session must have a recorded working directory.');

  const event = events[request.eventSeq];
  if (!event || event.seq !== request.eventSeq || !isHuman(event)) {
    fail('message-not-editable', 'Select a recorded human input message.');
  }
  if (event.data.id !== request.messageId) {
    fail('session-changed', 'The selected message changed. Reopen it and try again.');
  }
  if (!isSupportedContent(event.data)) {
    fail('message-not-editable', 'Select a supported user message.');
  }
  const hasAttachments = event.data.content.some(isAttachmentBlock);
  const text = request.action === 'edit' ? request.replacementText : textOf(event.data);
  if (
    typeof text !== 'string' ||
    (request.action === 'edit' ? !text.trim() : !text.trim() && !hasAttachments)
  ) {
    fail('empty-message', 'The new message must contain text.');
  }
  if (text.length > 131072) {
    fail('message-too-large', 'The new message is too large.');
  }

  const selectedModel = modelOf(events, options.defaultModel);
  const modelSelection =
    typeof selectedModel.provider === 'string' &&
    selectedModel.provider &&
    typeof selectedModel.model === 'string' &&
    selectedModel.model
      ? {
          provider: selectedModel.provider,
          model: selectedModel.model,
          ...(typeof selectedModel.reasoningEffort === 'string'
            ? { reasoningEffort: selectedModel.reasoningEffort }
            : {}),
        }
      : undefined;

  return {
    ...common,
    eventSeq: event.seq,
    messageId: event.data.id,
    ...(modelSelection ? { modelSelection } : {}),
    content:
      request.action === 'retry'
        ? structuredClone(event.data.content)
        : replaceMessageText(event.data.content, text),
  };
}

// Preserve the conversation's configuration while replacing its generated suffix.
const RETAINED_SETTINGS = new Set([
  'session/title', 'permission/preset', 'sandbox/mode', 'approval/policy',
  'agent-preset/selected', 'working-directory/change', 'plan/mode',
]);

function retainedTitleData(event, plan, editedSeq) {
  const data = event?.data;
  if (!data || typeof data.title !== 'string') return undefined;
  if (data.source?.kind === 'user') {
    return { title: data.title, messageSeqs: [], source: structuredClone(data.source) };
  }
  const seqs = data.messageSeqs;
  if (
    !Array.isArray(seqs) ||
    seqs.length === 0 ||
    !seqs.every(seq => seq < plan.eventSeq || (plan.action === 'retry' && seq === plan.eventSeq))
  ) {
    return undefined;
  }
  return {
    title: data.title,
    messageSeqs: seqs.map(seq => (seq === plan.eventSeq ? editedSeq : seq)),
    source: structuredClone(data.source),
  };
}

function sameModelSelection(a, b) {
  return (
    a?.provider === b?.provider &&
    a?.model === b?.model &&
    a?.reasoningEffort === b?.reasoningEffort
  );
}

export function rewriteSeed(snapshot, plan, message, now = Date.now()) {
  const { events, header } = snapshot;
  const target = events[plan.eventSeq];
  const seed = events.slice(0, plan.eventSeq);
  const inheritedEventCount = Math.min(snapshot.inheritedEventCount ?? 0, plan.eventSeq);
  const append = (type, data) => seed.push({ type, seq: seed.length, time: now, data });
  // Editing an inherited message moves this branch's inherited cut back to it.
  if (header.isSeeded && plan.eventSeq < snapshot.inheritedEventCount) {
    append('session/end-seed', { inherited: true });
  }
  seed.push({ ...target, seq: seed.length, time: now, data: message });
  const editedSeq = seed.length - 1;
  const closers = interruptedTurnClosers(seed);
  for (const event of closers) {
    seed.push(event.type === 'turn/end'
      ? { ...event, data: { ...event.data, reason: { kind: 'aborted', reason: { kind: 'user' } } } }
      : event);
  }
  // Imported histories may contain a user message outside a turn (including seq 0).
  if (!closers.some(event => event.type === 'turn/end')) {
    const turn = (seed.findLast(event => event.type === 'turn/start')?.data.turn ?? 0) + 1;
    append('turn/start', { turn });
    append('turn/end', { turn, reason: { kind: 'aborted', reason: { kind: 'user' } } });
  }
  const queues = foldInbox(seed);
  for (const target of ['next-turn', 'next-step']) {
    if (queues[target].length) append('agent/inbox/spliced', {
      target, start: 0, removedCount: queues[target].length, inserted: [], outcome: 'canceled',
    });
  }
  const settings = new Map();
  for (const event of events) {
    if (!RETAINED_SETTINGS.has(event.type)) continue;
    if (event.type === 'session/title' && !retainedTitleData(event, plan, editedSeq)) continue;
    settings.set(event.type, event);
  }
  for (const event of [...settings.values()].sort((a, b) => a.seq - b.seq)) {
    if (event.seq <= plan.eventSeq) continue;
    const data = event.type === 'session/title'
      ? retainedTitleData(event, plan, editedSeq)
      : structuredClone(event.data);
    if (data !== undefined) append(event.type, data);
  }
  if (plan.modelSelection && !sameModelSelection(modelOf(seed), plan.modelSelection)) {
    append('model/selection', plan.modelSelection);
  }
  return { events: seed, inheritedEventCount, editedSeq };
}
