// Sign-in screen, and the one-time setup screen that creates the first administrator.

import { api, busy, field, h } from '../ui.js';

export function authView(mode, onSignedIn) {
  const setup = mode === 'setup';
  const name = h('input', { type: 'text', autocomplete: 'name', placeholder: 'Your name' });
  const email = h('input', { type: 'email', autocomplete: 'username', placeholder: 'you@example.com' });
  const password = h('input', {
    type: 'password',
    autocomplete: setup ? 'new-password' : 'current-password',
    placeholder: setup ? 'At least 8 characters' : 'Password',
  });
  const error = h('div', { class: 'error-box', hidden: true });
  const submit = h('button', { class: 'primary', type: 'submit' }, setup ? 'Create administrator account' : 'Sign in');

  const form = h(
    'form',
    {
      class: 'auth-card',
      onsubmit: (event) => {
        event.preventDefault();
        error.hidden = true;
        busy(submit, async () => {
          try {
            const body = { email: email.value, password: password.value };
            const result = setup
              ? await api('POST', '/auth/setup', { ...body, name: name.value })
              : await api('POST', '/auth/login', body);
            onSignedIn(result.user);
          } catch (failure) {
            // Shown in the card rather than as a toast: it is the thing to read next.
            error.textContent = failure.message;
            error.hidden = false;
            password.select();
          }
        });
      },
    },
    h('div', { class: 'brand' }, h('span', { class: 'dot' }), h('div', null, h('b', null, 'Interview Assistant'))),
    h('h1', null, setup ? 'Set up this server' : 'Sign in'),
    h('p', { class: 'muted' }, setup
      ? 'Create the administrator account. It manages users, templates and the Claude connection, and takes over any data already on this server.'
      : 'Use the email and password your administrator gave you.'),
    setup ? field('Name', name) : null,
    field('Email', email),
    field('Password', password),
    error,
    submit,
  );
  setTimeout(() => (setup ? name : email).focus(), 0);
  return h('div', { class: 'auth' }, form);
}
