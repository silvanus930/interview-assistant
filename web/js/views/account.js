// The signed-in person's own account: name, password, model preference, and the extension.

import { api, busy, confirmDialog, copyText, field, h, toast } from '../ui.js';

export async function accountView(root) {
  const [account, meta] = await Promise.all([api('GET', '/account'), api('GET', '/meta')]);
  const draft = { name: account.name, email: account.email, model: account.model, effort: account.effort };
  const passwords = { current_password: '', new_password: '' };

  const text = (key, attrs = {}) =>
    h('input', { type: 'text', value: draft[key], oninput: (e) => (draft[key] = e.target.value), ...attrs });
  const secret = (key, attrs) =>
    h('input', { type: 'password', oninput: (e) => (passwords[key] = e.target.value), ...attrs });

  const model = h(
    'select',
    { value: draft.model, onchange: (e) => (draft.model = e.target.value) },
    h('option', { value: '' }, `Server default — ${meta.default_model}`),
    ...meta.models.map((m) => h('option', { value: m.id }, m.label && m.label !== m.id ? `${m.id} — ${m.label}` : m.id)),
  );
  const effort = h(
    'select',
    { value: draft.effort, onchange: (e) => (draft.effort = e.target.value) },
    h('option', { value: '' }, `Server default — ${meta.default_effort || 'model default'}`),
    ...meta.efforts.map((level) => h('option', { value: level }, level)),
  );

  const save = (event) =>
    busy(event.target, async () => {
      const result = await api('PUT', '/account', { ...draft, ...passwords });
      if (result.signed_out) {
        toast('Password changed. Sign in again with the new one.', 'ok');
        window.dispatchEvent(new Event('ia-signed-out'));
        return;
      }
      toast('Account saved', 'ok');
      window.dispatchEvent(new CustomEvent('ia-account-changed', { detail: result }));
    });

  const signOutExtension = (event) =>
    busy(event.target, async () => {
      if (!(await confirmDialog('Sign the browser extension out on every computer? You will need to sign in again in its settings.', 'Sign out the extension'))) return;
      await api('POST', '/account/extension-key');
      toast('The extension has been signed out everywhere.', 'ok');
    });

  const serverUrl = h('input', { type: 'text', readOnly: true, value: location.origin });

  root.append(
    h('div', { class: 'title' }, h('div', null, h('h1', null, 'Account'), h('div', { class: 'sub' }, `${account.email} · ${account.role}`)), h('button', { class: 'primary', onclick: save }, 'Save changes')),

    h('h2', null, 'Profile'),
    h('section', { class: 'panel' }, h('div', { class: 'row' }, field('Name', text('name')), field('Email (used to sign in)', text('email', { type: 'email' })))),

    h('h2', null, 'Answer preferences'),
    h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'row' },
        field('Model', model, 'Used for your answers unless a workflow step names its own. Your administrator decides which models are available.'),
        field('Effort', effort, 'Lower is faster. “low” suits live answers.'),
      ),
    ),

    h('h2', null, 'Password'),
    h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'row' },
        field('Current password', secret('current_password', { autocomplete: 'current-password' })),
        field('New password', secret('new_password', { autocomplete: 'new-password', placeholder: 'Leave blank to keep the current one' }), 'At least 8 characters. Changing it signs you out everywhere.'),
      ),
    ),

    h('h2', null, 'Browser extension'),
    h(
      'section',
      { class: 'panel' },
      h('p', { class: 'muted' }, 'The extension is your client during a call: it catches the interviewer’s questions and shows the answers. It signs in with the same email and password as this dashboard.'),
      h(
        'ol',
        { class: 'howto' },
        h('li', null, 'On the call page, open the extension panel and press the settings button.'),
        h('li', null, 'Enter the server address below, your email and your password, then press Sign in.'),
        h('li', null, 'Pick the profile whose résumé should be used, and save.'),
      ),
      h('div', { class: 'row end' }, field('Server address', serverUrl), h('button', { type: 'button', onclick: () => copyText(serverUrl.value) }, 'Copy')),
      h('div', { class: 'row between' }, h('span', { class: 'hint' }, 'Lost a laptop, or shared your sign-in by mistake? This disconnects every extension signed in as you.'), h('button', { type: 'button', class: 'danger ghost', onclick: signOutExtension }, 'Sign out the extension everywhere')),
    ),
  );
  return undefined;
}
