// Sign-in screen. The administrator account is created by the server on first start.

import { api, busy, field, h } from '../ui.js';

export function authView(onSignedIn) {
  const email = h('input', { type: 'email', autocomplete: 'username', placeholder: 'you@example.com' });
  const password = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password' });
  const error = h('div', { class: 'error-box', hidden: true });
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Sign in');

  const form = h(
    'form',
    {
      class: 'auth-card',
      onsubmit: (event) => {
        event.preventDefault();
        error.hidden = true;
        busy(submit, async () => {
          try {
            const result = await api('POST', '/auth/login', { email: email.value, password: password.value });
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
    h('h1', null, 'Sign in'),
    h('p', { class: 'muted' }, 'Use the email and password your administrator gave you.'),
    field('Email', email),
    field('Password', password),
    error,
    submit,
  );
  setTimeout(() => email.focus(), 0);
  return h('div', { class: 'auth' }, form);
}
