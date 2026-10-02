// Small DOM, API and dialog helpers shared by every view.

import { session } from './session.js';

/** Build an element. Strings become text nodes, so user data is never parsed as HTML. */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'value') continue; // set below, once a <select>'s options exist
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key in el && key !== 'list' && key !== 'form') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  if (attrs && attrs.value !== null && attrs.value !== undefined) el.value = attrs.value;
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Replace an element's content; accepts the same nested/nullable children as h(). */
export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

function errorText(data) {
  if (!data || data.detail === undefined) return '';
  if (typeof data.detail === 'string') return data.detail;
  if (Array.isArray(data.detail)) {
    return data.detail
      .map((d) => {
        const field = (d.loc || []).filter((p) => p !== 'body').join(' → ');
        const msg = String(d.msg || '').replace(/^Value error, /, '');
        return field ? `${field}: ${msg}` : msg;
      })
      .join('\n');
  }
  return JSON.stringify(data.detail);
}

export async function api(method, path, body) {
  const options = { method, headers: {} };
  // An admin working in someone else's workspace: the server applies the request to that user.
  if (session.actAs) options.headers['X-Act-As'] = String(session.actAs.id);
  if (body instanceof FormData) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch('/api' + path, options);
  } catch {
    throw new Error('Cannot reach the server. Is it still running?');
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (response.status === 401 && !path.startsWith('/auth/')) {
    // The session ended (signed out elsewhere, password changed, account disabled).
    window.dispatchEvent(new Event('ia-signed-out'));
  }
  if (!response.ok) throw new Error(errorText(data) || `Request failed (${response.status})`);
  return data;
}

export function toast(message, kind = 'info') {
  const el = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

/** Run an async action from a button: disables it meanwhile and reports failures. */
export async function busy(button, action) {
  const label = button.textContent;
  button.disabled = true;
  try {
    return await action();
  } catch (error) {
    toast(error.message, 'error');
    return undefined;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const root = document.getElementById('modal-root');
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (onClose) onClose();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  const backdrop = h(
    'div',
    { class: 'backdrop', onmousedown: (event) => event.target === backdrop && close() },
    h(
      'div',
      { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
      h('header', null, h('h2', null, title), h('button', { class: 'icon', title: 'Close', onclick: close }, '×')),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('footer', null, actions) : null,
    ),
  );
  document.addEventListener('keydown', onKey);
  root.append(backdrop);
  return close;
}

export function confirmDialog(message, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value) => {
      answered = true;
      close();
      resolve(value);
    };
    const close = modal({
      title: 'Please confirm',
      body: h('p', null, message),
      actions: [
        h('button', { onclick: () => answer(false) }, 'Cancel'),
        h('button', { class: 'danger', onclick: () => answer(true) }, confirmLabel),
      ],
      onClose: () => answered || resolve(false),
    });
  });
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}

export function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function seconds(ms) {
  return ms ? `${(ms / 1000).toFixed(1)}s` : '';
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Could not copy to the clipboard', 'error');
  }
}

/** Insert text at the cursor of a textarea/input and keep focus there. */
export function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.setRangeText(text, start, end, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}
