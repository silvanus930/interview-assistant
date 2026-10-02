// Admin landing page: how the platform is being used.

import { api, formatTime, h, mount } from '../ui.js';

const SOURCES = { ui: 'Dashboard', telegram: 'Telegram', extension: 'Extension' };

function lastSevenDays(byDay) {
  const counts = Object.fromEntries(byDay.map((d) => [d.day, d.runs]));
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000);
    const key = date.toISOString().slice(0, 10); // the server groups by UTC day
    days.push({ label: date.toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' }), runs: counts[key] || 0 });
  }
  return days;
}

export async function overviewView(root) {
  const o = await api('GET', '/admin/overview');
  const stat = (key, value, detail) => h('div', { class: 'stat' }, h('div', { class: 'k' }, key), h('div', { class: 'v' }, value), detail ? h('div', { class: 'd' }, detail) : null);
  const days = lastSevenDays(o.by_day);
  const peak = Math.max(1, ...days.map((d) => d.runs));
  const tg = o.telegram;

  mount(
    root,
    h('div', { class: 'title' }, h('div', null, h('h1', null, 'Overview'), h('div', { class: 'sub' }, 'Usage across every account on this server.')), h('a', { class: 'button primary', href: '#/users' }, 'Manage users')),

    o.auth_mode === 'subscription' && o.users > 1
      ? h('div', { class: 'banner info' }, h('span', null, 'This server runs on your personal Claude subscription, so only administrator accounts generate answers. Other users can sign in and manage their profiles and workflows.'))
      : null,

    h(
      'div',
      { class: 'stats' },
      stat('Users', o.users, `${o.active_users} active · ${o.users_active_week} used it this week`),
      stat('Answers · 24 h', o.runs_day, `${o.runs_week} in the last 7 days`),
      stat('Average time', o.avg_seconds_week ? `${o.avg_seconds_week.toFixed(1)}s` : '—', 'per answer, last 7 days'),
      stat('Failed · 7 days', o.errors_week, o.runs_week ? `${Math.round((100 * o.errors_week) / o.runs_week)}% of answers` : 'no answers yet'),
      stat('Usage · 7 days', `$${o.cost_week.toFixed(2)}`, 'at API prices, as reported by Claude'),
    ),

    h('h2', null, 'Answers per day'),
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'bars' }, days.map((d) => h('div', { class: 'bar' }, h('b', null, d.runs || ''), h('i', { style: `height:${Math.round((100 * d.runs) / peak)}%` }), h('span', null, d.label)))),
      h('div', { class: 'badges' }, o.by_source.length
        ? o.by_source.map((s) => h('span', { class: 'badge' }, `${SOURCES[s.source] || s.source} · ${s.runs}`))
        : h('span', { class: 'muted' }, 'No answers in the last 7 days.')),
    ),

    h('h2', null, 'System'),
    h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'row between' },
        h('span', null, h('span', { class: `badge ${o.auth_mode === 'api_key' ? 'ok' : 'warn'}` }, o.auth_mode === 'api_key' ? 'API key' : 'Subscription'), ` Claude · default model ${o.default_model}`),
        h('span', null, h('span', { class: `badge ${tg.state === 'running' ? 'ok' : tg.state === 'error' ? 'bad' : ''}` }, tg.state), tg.bot_username ? ` Telegram · @${tg.bot_username}` : ' Telegram bot'),
        h('span', { class: 'muted' }, `${o.templates} template${o.templates === 1 ? '' : 's'}`),
        h('a', { class: 'button small', href: '#/system' }, 'Settings'),
      ),
    ),

    h('h2', null, 'Latest failures'),
    o.recent_errors.length
      ? h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['When', 'User', 'Question', 'Error'].map((t) => h('th', null, t)))),
          h('tbody', null, o.recent_errors.map((e) => h('tr', null,
            h('td', { class: 'nowrap muted' }, formatTime(e.created_at)),
            h('td', null, e.user_name || '—'),
            h('td', { class: 'question' }, e.question),
            h('td', { class: 'muted' }, e.error))))))
      : h('div', { class: 'empty' }, h('p', null, 'No failed answers.')),
  );
  return undefined;
}
