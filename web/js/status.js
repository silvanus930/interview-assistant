// Sidebar connection status for Claude and Telegram.

import { api, h } from './ui.js';

export async function refreshStatus() {
  const el = document.getElementById('status');
  if (!el) return;
  let status;
  try {
    status = await api('GET', '/status');
  } catch {
    el.replaceChildren(h('div', { class: 'status-line' }, h('span', { class: 'dot bad' }), 'Server offline'));
    return;
  }
  const tg = status.telegram;
  let dot = '';
  let text = 'Telegram: not set up';
  if (tg.token_set && !tg.listener_enabled) {
    dot = 'ok';
    text = 'Telegram: send only';
  } else if (tg.state === 'running') {
    dot = 'ok';
    text = `Telegram: @${tg.bot_username}`;
  } else if (tg.state === 'error') {
    dot = 'bad';
    text = 'Telegram: error';
  } else if (tg.token_set) {
    text = 'Telegram: connecting…';
  }
  const claude = status.can_generate
    ? [h('span', { class: 'dot ok' }), `Claude: ${status.default_model}`]
    : [h('span', { class: 'dot warn' }), 'Claude: not available to you'];
  el.replaceChildren(
    h('div', { class: 'status-line', title: status.auth_mode === 'api_key' ? 'Runs on an Anthropic API key' : 'Runs on the owner’s Claude subscription' }, claude),
    h('div', { class: 'status-line', title: tg.error || '' }, h('span', { class: `dot ${dot}` }), text),
  );
}
