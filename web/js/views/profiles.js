import { api, busy, confirmDialog, field, h, modal, toast } from '../ui.js';

const BLANK = {
  name: '',
  target_role: '',
  company: '',
  job_description: '',
  notes: '',
  resume_filename: '',
  resume_text: '',
  telegram_chat_id: '',
  telegram_listen: true,
  workflow_id: null,
};

export async function profilesView(root) {
  const list = h('div', { class: 'cards' });
  let workflows = [];

  async function refresh() {
    const [profiles, flows] = await Promise.all([api('GET', '/profiles'), api('GET', '/workflows')]);
    workflows = flows;
    list.replaceChildren(
      ...(profiles.length
        ? profiles.map(card)
        : [h('div', { class: 'empty' }, h('p', null, 'No profiles yet. A profile is one candidate + résumé + Telegram chat.'))]),
    );
  }

  function card(profile) {
    const flow = workflows.find((w) => w.id === profile.workflow_id);
    return h(
      'article',
      { class: 'card' },
      h('h3', null, profile.name),
      h('p', { class: 'muted' }, [profile.target_role, profile.company].filter(Boolean).join(' @ ') || 'No target role set'),
      h(
        'dl',
        null,
        h('dt', null, 'Résumé'),
        h('dd', null, profile.resume_text
          ? `${profile.resume_filename || 'pasted text'} · ${profile.resume_text.length.toLocaleString()} characters`
          : h('span', { class: 'warn' }, 'missing')),
        h('dt', null, 'Telegram'),
        h('dd', null, profile.telegram_chat_id
          ? `${profile.telegram_chat_id}${profile.telegram_listen ? ' · answers questions from this chat' : ''}`
          : h('span', { class: 'warn' }, 'no chat ID')),
        h('dt', null, 'Workflow'),
        h('dd', null, flow ? flow.name : 'Default workflow'),
      ),
      h(
        'footer',
        null,
        h('button', { onclick: () => edit(profile) }, 'Edit'),
        h('button', {
          class: 'danger ghost',
          onclick: async () => {
            if (!(await confirmDialog(`Delete the profile “${profile.name}”? Its past answers stay in History.`))) return;
            try {
              await api('DELETE', `/profiles/${profile.id}`);
              await refresh();
            } catch (error) {
              toast(error.message, 'error');
            }
          },
        }, 'Delete'),
      ),
    );
  }

  function edit(existing) {
    const draft = { ...BLANK, ...(existing || {}) };
    const input = (key, attrs = {}) =>
      h('input', { type: 'text', value: draft[key] || '', oninput: (e) => (draft[key] = e.target.value), ...attrs });
    const area = (key, rows, placeholder) =>
      h('textarea', { rows, placeholder, value: draft[key] || '', oninput: (e) => (draft[key] = e.target.value) });

    // --- résumé upload
    const resumeArea = area('resume_text', 10, 'Upload a file above, or paste the résumé text here.');
    const resumeInfo = h('span', { class: 'hint' });
    const describeResume = () => {
      resumeInfo.textContent = draft.resume_text
        ? `${draft.resume_filename || 'pasted text'} · ${draft.resume_text.length.toLocaleString()} characters. This text is what Claude reads — fix anything that extracted badly.`
        : 'PDF, DOCX, TXT or MD. The text is extracted locally and shown below for you to check.';
    };
    resumeArea.addEventListener('input', describeResume);
    const fileInput = h('input', {
      type: 'file',
      accept: '.pdf,.docx,.txt,.md,.markdown',
      onchange: async () => {
        const file = fileInput.files[0];
        if (!file) return;
        const form = new FormData();
        form.append('file', file);
        resumeInfo.textContent = 'Reading file…';
        try {
          const result = await api('POST', '/resume/extract', form);
          draft.resume_text = result.text;
          draft.resume_filename = result.filename;
          resumeArea.value = result.text;
          toast(`Extracted ${result.chars.toLocaleString()} characters from ${result.filename}`, 'ok');
        } catch (error) {
          toast(error.message, 'error');
        }
        fileInput.value = '';
        describeResume();
      },
    });
    describeResume();

    // --- Telegram chat
    const chatInput = input('telegram_chat_id', { placeholder: 'e.g. 123456789', inputmode: 'numeric' });
    const chatPanel = h('div', { class: 'detect' });
    const detect = (event) =>
      busy(event.target, async () => {
        const [chats, status] = await Promise.all([api('GET', '/telegram/chats'), api('GET', '/status')]);
        const tg = status.telegram;
        if (!tg.token_set) {
          chatPanel.replaceChildren(h('p', { class: 'warn' }, 'The Telegram bot is not set up yet. An administrator adds it under Claude & Telegram.'));
        } else if (!chats.length) {
          const bot = tg.bot_username ? `@${tg.bot_username}` : 'your bot';
          chatPanel.replaceChildren(
            h('p', { class: 'muted' }, tg.state === 'running'
              ? `No chats seen yet. Open ${bot} in Telegram, send /start, then press Detect again. The bot also replies with the chat ID.`
              : `The Telegram bot is not listening${tg.error ? ` (${tg.error})` : ''}. An administrator can check it under Claude & Telegram.`),
          );
        } else {
          chatPanel.replaceChildren(
            ...chats.map((chat) =>
              h('button', {
                class: 'chip',
                type: 'button',
                onclick: () => {
                  draft.telegram_chat_id = chat.chat_id;
                  chatInput.value = chat.chat_id;
                },
              }, `${chat.title}${chat.username ? ` (@${chat.username})` : ''} · ${chat.chat_id}`),
            ),
          );
        }
      });
    const sendTest = (event) =>
      busy(event.target, async () => {
        const chatId = chatInput.value.trim();
        if (!chatId) throw new Error('Enter a chat ID first.');
        const result = await api('POST', '/telegram/send-test', { chat_id: chatId });
        if (!result.ok) throw new Error(result.error);
        toast('Test message sent. Check Telegram.', 'ok');
      });

    const listen = h('input', {
      type: 'checkbox',
      checked: draft.telegram_listen,
      onchange: (e) => (draft.telegram_listen = e.target.checked),
    });
    const workflowSelect = h(
      'select',
      { value: draft.workflow_id || '', onchange: (e) => (draft.workflow_id = Number(e.target.value) || null) },
      h('option', { value: '' }, 'Default workflow'),
      ...workflows.map((w) => h('option', { value: w.id }, w.name)),
    );

    const save = (event) =>
      busy(event.target, async () => {
        if (!draft.name.trim()) throw new Error('Give the profile a name.');
        if (existing) await api('PUT', `/profiles/${existing.id}`, draft);
        else await api('POST', '/profiles', draft);
        close();
        toast('Profile saved', 'ok');
        await refresh();
      });

    const close = modal({
      title: existing ? `Edit ${existing.name}` : 'New profile',
      wide: true,
      body: [
        h(
          'div',
          { class: 'row' },
          field('Candidate name', input('name', { placeholder: 'Used as {{candidate_name}}' })),
          field('Target role', input('target_role', { placeholder: 'e.g. Senior Backend Engineer' })),
          field('Company', input('company', { placeholder: 'e.g. Acme' })),
        ),
        field('Résumé file', fileInput, resumeInfo),
        resumeArea,
        field('Job description', area('job_description', 5, 'Paste the job posting so answers can be tied to it. Optional.')),
        field('Notes', area('notes', 3, 'Anything else Claude should know: strengths to stress, topics to avoid, answer language, tone… Optional.')),
        h('h3', null, 'Telegram'),
        h(
          'div',
          { class: 'row end' },
          field('Chat ID', chatInput),
          h('button', { type: 'button', onclick: detect }, 'Detect'),
          h('button', { type: 'button', onclick: sendTest }, 'Send test'),
        ),
        chatPanel,
        h('label', { class: 'check' }, listen, 'Answer questions sent to the bot from this chat'),
        field('Workflow', workflowSelect, 'Which workflow answers this profile’s questions.'),
      ],
      actions: [
        h('button', { onclick: () => close() }, 'Cancel'),
        h('button', { class: 'primary', onclick: save }, 'Save profile'),
      ],
    });
  }

  root.append(
    h('div', { class: 'title' }, h('h1', null, 'Profiles'), h('button', { class: 'primary', onclick: () => edit(null) }, 'New profile')),
    list,
  );
  await refresh();
  return undefined;
}
