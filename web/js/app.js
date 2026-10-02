import { isAdmin, restoreActAs, session, setActAs } from './session.js';
import { refreshStatus } from './status.js';
import { api, h, mount, toast } from './ui.js';
import { accountView } from './views/account.js';
import { overviewView } from './views/admin_overview.js';
import { systemView } from './views/admin_system.js';
import { usersView } from './views/admin_users.js';
import { askView } from './views/ask.js';
import { authView } from './views/auth.js';
import { historyView } from './views/history.js';
import { profilesView } from './views/profiles.js';
import { templatesView, workflowsView } from './views/workflows.js';

// Workspace pages belong to one user; admin pages manage the whole platform.
const WORKSPACE = [
  ['ask', 'Ask', askView],
  ['profiles', 'Profiles', profilesView],
  ['workflows', 'Workflows', workflowsView],
  ['history', 'History', historyView],
];
const ADMIN = [
  ['overview', 'Overview', overviewView],
  ['users', 'Users', usersView],
  ['templates', 'Templates', templatesView],
  ['system', 'Claude & Telegram', systemView],
];
const VIEWS = Object.fromEntries([...WORKSPACE, ...ADMIN, ['account', 'Account', accountView]].map(([k, , v]) => [k, v]));
const ADMIN_ONLY = new Set(ADMIN.map(([k]) => k));

const app = document.getElementById('app');
let main = null;
let cleanup = null;
let navigation = 0;
let statusTimer = null;

const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

function shell() {
  const link = ([key, label]) => h('a', { href: `#/${key}`, dataset: { view: key } }, label);
  main = h('main', { class: 'main' });
  app.replaceChildren(
    h(
      'div',
      { class: 'shell' },
      h(
        'aside',
        { class: 'sidebar' },
        h('div', { class: 'brand' }, h('span', { class: 'dot' }), h('div', null, h('b', null, 'Interview Assistant'), h('span', null, isAdmin() ? 'Admin console' : 'Workspace'))),
        isAdmin() ? [h('div', { class: 'nav-label' }, 'Admin'), h('nav', { class: 'nav' }, ADMIN.map(link))] : null,
        h('div', { class: 'nav-label' }, session.actAs ? `${session.actAs.name}’s workspace` : 'My workspace'),
        h('nav', { class: 'nav' }, WORKSPACE.map(link)),
        h(
          'div',
          { class: 'side-foot' },
          h('div', { class: 'status', id: 'status' }),
          h(
            'div',
            { class: 'user-chip' },
            h('span', { class: 'avatar' }, initials(session.me.name)),
            h('a', { class: 'who', href: '#/account', style: 'text-decoration:none;color:inherit', title: 'Account settings' }, h('b', null, session.me.name), h('span', null, session.me.role)),
            h('button', { class: 'ghost small', title: 'Sign out', onclick: signOut }, 'Sign out'),
          ),
        ),
      ),
      main,
    ),
  );
  clearInterval(statusTimer);
  refreshStatus();
  statusTimer = setInterval(refreshStatus, 8000);
}

async function signOut() {
  try {
    await api('POST', '/auth/logout');
  } catch {
    /* already signed out */
  }
  setActAs(null);
  session.me = null;
  showAuth();
}

function showAuth() {
  if (cleanup) cleanup();
  cleanup = null;
  clearInterval(statusTimer);
  main = null;
  document.getElementById('modal-root').replaceChildren();
  app.replaceChildren(authView((user) => {
    session.me = user;
    start();
  }));
}

/** Open (or leave) another user's workspace; admins only. */
function openWorkspace(user) {
  setActAs(user);
  shell();
  if (location.hash === '#/ask') route();
  else location.hash = '#/ask';
}

async function route() {
  if (!main) return;
  const [name, param] = location.hash.replace(/^#\/?/, '').split('/');
  const view = VIEWS[name];
  if (!view || (ADMIN_ONLY.has(name) && !isAdmin())) {
    location.hash = isAdmin() ? '#/overview' : '#/ask';
    return;
  }
  const current = ++navigation;
  if (cleanup) cleanup();
  cleanup = null;
  for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('active', a.dataset.view === name);

  // Render into a detached container so a slow view cannot paint over a newer one.
  const container = h('div', { class: 'view' });
  const inWorkspace = !ADMIN_ONLY.has(name) && name !== 'account';
  mount(
    main,
    session.actAs && inWorkspace
      ? h('div', { class: 'banner info' }, h('span', null, `You are working in ${session.actAs.name}’s workspace. Changes here apply to their account.`), h('button', { class: 'small', onclick: () => openWorkspace(null) }, 'Back to my workspace'))
      : null,
    container,
  );
  main.scrollTop = 0;
  try {
    const dispose = await view(container, param);
    if (current === navigation) cleanup = dispose || null;
    else if (dispose) dispose();
  } catch (error) {
    if (current === navigation) container.replaceChildren(h('div', { class: 'error-box' }, error.message));
  }
}

function start() {
  restoreActAs();
  shell();
  route();
}

async function boot() {
  let state;
  try {
    state = await api('GET', '/auth/state');
  } catch (error) {
    app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'auth-card' }, h('div', { class: 'error-box' }, error.message))));
    return;
  }
  session.me = state.user;
  if (!state.user) showAuth();
  else start();
}

window.addEventListener('hashchange', route);
window.addEventListener('ia-signed-out', () => {
  if (!session.me) return;
  session.me = null;
  setActAs(null);
  toast('You have been signed out.', 'error');
  showAuth();
});
// The Users page asks to open someone's workspace.
window.addEventListener('ia-open-workspace', (event) => openWorkspace(event.detail));
// Views call this after changing the signed-in account's own name.
window.addEventListener('ia-account-changed', (event) => {
  session.me = event.detail;
  shell();
  route();
});
boot();
