import { runCard } from '../runcard.js';
import { api, busy, field, h, mount, toast } from '../ui.js';

const PROFILE_KEY = 'ia.profile';
const REFRESH_MS = 4000;

function remembered() {
  try {
    return Number(localStorage.getItem(PROFILE_KEY)) || null;
  } catch {
    return null;
  }
}

function remember(id) {
  try {
    localStorage.setItem(PROFILE_KEY, String(id));
  } catch {
    /* storage unavailable; the choice just is not remembered */
  }
}

export async function askView(root) {
  const [profiles, workflows, status] = await Promise.all([api('GET', '/profiles'), api('GET', '/workflows'), api('GET', '/status')]);
  // Say why this account cannot generate answers before they try.
  const blocked = status.can_generate
    ? null
    : h('div', { class: 'banner' }, h('span', null, status.access_message), h('a', { class: 'button small', href: '#/account' }, 'Open Account'));

  if (!profiles.length) {
    mount(
      root,
      h('h1', null, 'Ask'),
      blocked,
      h(
        'div',
        { class: 'empty' },
        h('p', null, 'Create a profile first: upload a résumé and add the Telegram chat ID that should receive the answers.'),
        h('a', { class: 'button primary', href: '#/profiles' }, 'Create a profile'),
      ),
    );
    return undefined;
  }

  const cards = new Map();
  const defaultWorkflow = workflows.find((w) => w.is_default) || workflows[0];
  const saved = remembered();
  let profile = profiles.find((p) => p.id === saved) || profiles[0];

  const profileSelect = h('select', { value: profile.id }, profiles.map((p) => h('option', { value: p.id }, p.name)));
  const workflowSelect = h('select');
  const sendToggle = h('input', { type: 'checkbox' });
  const sendHint = h('span', { class: 'hint' });
  const question = h('textarea', {
    rows: 3,
    placeholder: 'Type or paste the interview question…  (Ctrl+Enter to send)',
  });
  const askButton = h('button', { class: 'primary' }, 'Generate answer');
  const feed = h('div', { class: 'feed' });

  function syncProfile() {
    const own = workflows.find((w) => w.id === profile.workflow_id) || defaultWorkflow;
    workflowSelect.replaceChildren(
      h('option', { value: '' }, `Profile default — ${own ? own.name : 'none'}`),
      ...workflows.map((w) => h('option', { value: w.id }, w.name)),
    );
    const hasChat = Boolean(profile.telegram_chat_id);
    sendToggle.checked = hasChat;
    sendToggle.disabled = !hasChat;
    sendHint.textContent = hasChat ? `chat ${profile.telegram_chat_id}` : 'no chat ID on this profile';
  }

  // Have the server start Claude for this profile now, so the answer does not wait for it.
  function getReady() {
    if (!status.can_generate) return;
    api('POST', '/runs/warm', { profile_id: profile.id, workflow_id: Number(workflowSelect.value) || null }).catch(() => {});
  }

  function addCard(run, { top }) {
    if (cards.has(run.id)) return;
    const card = runCard(run);
    cards.set(run.id, card);
    if (top) feed.prepend(card.el);
    else feed.append(card.el);
  }

  async function loadFeed() {
    for (const card of cards.values()) card.destroy();
    cards.clear();
    feed.replaceChildren();
    const runs = await api('GET', `/runs?limit=15&profile_id=${profile.id}`);
    runs.forEach((run) => addCard(run, { top: false }));
  }

  // Questions sent to the bot from Telegram show up here without a reload.
  async function pollNew() {
    const id = profile.id;
    try {
      const runs = await api('GET', `/runs?limit=15&profile_id=${id}`);
      if (id !== profile.id) return; // the profile was switched while this was loading
      runs.reverse().forEach((run) => addCard(run, { top: true }));
    } catch {
      /* transient; the next tick retries */
    }
  }

  async function ask() {
    const text = question.value.trim();
    if (!text) {
      question.focus();
      return;
    }
    await busy(askButton, async () => {
      const run = await api('POST', '/runs', {
        profile_id: profile.id,
        workflow_id: Number(workflowSelect.value) || null,
        question: text,
        send_telegram: sendToggle.checked,
      });
      question.value = '';
      addCard(run, { top: true });
    });
    question.focus();
  }

  profileSelect.addEventListener('change', async () => {
    profile = profiles.find((p) => p.id === Number(profileSelect.value));
    remember(profile.id);
    syncProfile();
    getReady();
    await loadFeed().catch((error) => toast(error.message, 'error'));
  });
  workflowSelect.addEventListener('change', getReady);
  askButton.addEventListener('click', ask);
  question.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      ask();
    }
  });

  mount(
    root,
    h('h1', null, 'Ask'),
    blocked,
    h(
      'section',
      { class: 'panel hero' },
      h('div', { class: 'row' }, field('Profile', profileSelect), field('Workflow', workflowSelect)),
      question,
      h(
        'div',
        { class: 'row between' },
        h('label', { class: 'check' }, sendToggle, 'Send the answer to Telegram', sendHint),
        askButton,
      ),
    ),
    h('h2', null, 'Recent answers'),
    feed,
  );

  syncProfile();
  getReady();
  await loadFeed();
  question.focus();
  const timer = setInterval(pollNew, REFRESH_MS);

  return () => {
    clearInterval(timer);
    for (const card of cards.values()) card.destroy();
  };
}
