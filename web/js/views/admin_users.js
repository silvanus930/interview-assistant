// Admin: create and manage accounts.

import { session } from '../session.js';
import { api, busy, confirmDialog, field, formatTime, h, modal, mount, toast } from '../ui.js';

export async function usersView(root) {
  const body = h('tbody');
  const requests = h('div');
  let meta = null;
  // Answer access only applies on an API key; on a personal subscription only admins generate.
  const gated = (await api('GET', '/status')).auth_mode === 'api_key';

  async function refresh() {
    const [users, m] = await Promise.all([api('GET', '/admin/users'), meta || api('GET', '/meta')]);
    meta = m;
    body.replaceChildren(...users.map(row));
    const pending = gated ? users.filter((u) => u.role !== 'admin' && u.access_status === 'pending') : [];
    mount(
      requests,
      pending.length
        ? [
            h('h2', null, `Access requests (${pending.length})`),
            h('div', { class: 'table-wrap' }, h('table', null,
              h('thead', null, h('tr', null, ['User', 'Requested', ''].map((t) => h('th', null, t)))),
              h('tbody', null, ...pending.map((user) => h('tr', null,
                h('td', null, h('b', null, user.name), h('span', { class: 'sub' }, user.email)),
                h('td', { class: 'nowrap muted' }, user.access_requested_at ? formatTime(user.access_requested_at) : ''),
                h('td', { class: 'actions' },
                  h('button', { class: 'small danger ghost', onclick: decide(user, 'reject') }, 'Reject'), ' ',
                  h('button', { class: 'small primary', onclick: decide(user, 'approve') }, 'Accept'))))))),
          ]
        : null,
    );
  }

  const decide = (user, decision) => (event) =>
    busy(event.target, async () => {
      await api('POST', `/admin/users/${user.id}/access`, { decision });
      const done = { approve: `${user.name} can now generate answers.`, reject: `${user.name}'s request was rejected.`, revoke: `${user.name} can no longer generate answers.` };
      toast(done[decision], 'ok');
      await refresh();
    });

  function access(user) {
    if (user.role === 'admin') return h('span', { class: 'badge ok' }, 'always');
    const [tone, label] = { approved: ['ok', 'approved'], pending: ['warn', 'requested'], rejected: ['bad', 'rejected'] }[user.access_status] || ['', 'no access'];
    return h('span', { class: `badge ${tone}` }, label);
  }

  function row(user) {
    const me = user.id === session.me.id;
    return h(
      'tr',
      { class: user.is_active ? '' : 'off' },
      h('td', null, h('b', null, user.name), me ? h('span', { class: 'badge accent', style: 'margin-left:8px' }, 'you') : null, h('span', { class: 'sub' }, user.email)),
      h('td', null, h('span', { class: `badge ${user.role === 'admin' ? 'accent' : ''}` }, user.role), user.is_active ? null : h('span', { class: 'badge bad', style: 'margin-left:6px' }, 'disabled')),
      gated ? h('td', null, access(user)) : null,
      h('td', null, user.model || h('span', { class: 'muted' }, 'default')),
      h('td', { class: 'nowrap' }, `${user.profile_count} · ${user.workflow_count}`),
      h('td', { class: 'nowrap' }, user.run_count, h('span', { class: 'sub' }, user.last_run_at ? `last ${formatTime(user.last_run_at)}` : 'never')),
      h('td', { class: 'nowrap muted' }, user.last_login_at ? formatTime(user.last_login_at) : 'never'),
      h(
        'td',
        { class: 'actions' },
        me ? null : h('button', { class: 'small', title: 'Open their profiles, workflows and history', onclick: () => window.dispatchEvent(new CustomEvent('ia-open-workspace', { detail: user })) }, 'Open workspace'),
        ' ',
        !gated || user.role === 'admin' ? null
          : user.access_status === 'approved' ? h('button', { class: 'small danger ghost', onclick: decide(user, 'revoke') }, 'Revoke access')
          : user.access_status === 'pending' ? null
          : h('button', { class: 'small', title: 'Let them generate answers without a request', onclick: decide(user, 'approve') }, 'Grant access'),
        ' ',
        h('button', { class: 'small', onclick: () => edit(user) }, 'Edit'),
      ),
    );
  }

  function edit(existing) {
    const draft = existing
      ? { name: existing.name, email: existing.email, role: existing.role, is_active: existing.is_active, model: existing.model, effort: existing.effort, new_password: '' }
      : { name: '', email: '', role: 'user', password: '' };
    const me = existing && existing.id === session.me.id;
    const input = (key, attrs = {}) => h('input', { type: 'text', value: draft[key] ?? '', oninput: (e) => (draft[key] = e.target.value), ...attrs });
    const role = h('select', { value: draft.role, onchange: (e) => (draft.role = e.target.value) },
      h('option', { value: 'user' }, 'User — own workspace only'),
      h('option', { value: 'admin' }, 'Administrator — manages the platform'));

    const save = (event) =>
      busy(event.target, async () => {
        if (existing) await api('PUT', `/admin/users/${existing.id}`, draft);
        else await api('POST', '/admin/users', draft);
        close();
        toast(existing ? 'User saved' : 'User created. Give them their email and password.', 'ok');
        await refresh();
      });
    const remove = async () => {
      if (!(await confirmDialog(`Delete ${existing.name} and everything in their workspace (profiles, workflows, history)? This cannot be undone.`, 'Delete user'))) return;
      try {
        await api('DELETE', `/admin/users/${existing.id}`);
        close();
        toast('User deleted', 'ok');
        await refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    };

    const close = modal({
      title: existing ? `Edit ${existing.name}` : 'New user',
      body: [
        field('Name', input('name')),
        field('Email (they sign in with this)', input('email', { type: 'email', autocomplete: 'off' })),
        field('Role', role),
        existing
          ? field('Reset password', input('new_password', { type: 'password', autocomplete: 'new-password', placeholder: 'Leave blank to keep their password' }), 'Setting a new password signs them out everywhere.')
          : field('Password', input('password', { type: 'password', autocomplete: 'new-password', placeholder: 'At least 8 characters' }), 'They can change it under Account after signing in. A new user starts with a copy of every template.'),
        existing
          ? [
              h('div', { class: 'row' },
                field('Model', h('select', { value: draft.model, onchange: (e) => (draft.model = e.target.value) },
                  h('option', { value: '' }, `Server default — ${meta.default_model}`),
                  ...meta.models.map((m) => h('option', { value: m.id }, m.id)))),
                field('Effort', h('select', { value: draft.effort, onchange: (e) => (draft.effort = e.target.value) },
                  h('option', { value: '' }, 'Server default'),
                  ...meta.efforts.map((level) => h('option', { value: level }, level))))),
              me ? null : h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: draft.is_active, onchange: (e) => (draft.is_active = e.target.checked) }), 'Account is active (untick to block sign-in without deleting their data)'),
            ]
          : null,
      ],
      actions: [
        existing && !me ? h('button', { class: 'danger ghost', onclick: remove }, 'Delete user') : null,
        h('span', { class: 'spacer' }),
        h('button', { onclick: () => close() }, 'Cancel'),
        h('button', { class: 'primary', onclick: save }, existing ? 'Save' : 'Create user'),
      ].filter(Boolean),
    });
  }

  root.append(
    h('div', { class: 'title' }, h('div', null, h('h1', null, 'Users'), h('div', { class: 'sub' }, 'Each user has their own résumés, workflows, history and extension sign-in.')), h('button', { class: 'primary', onclick: () => edit(null) }, 'New user')),
    h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['User', 'Role', gated ? 'Answer access' : null, 'Model', 'Profiles · Workflows', 'Answers', 'Last sign-in', ''].filter((t) => t !== null).map((t) => h('th', null, t)))),
      body)),
  );
  root.insertBefore(requests, root.children[1]);
  await refresh();
  return undefined;
}
