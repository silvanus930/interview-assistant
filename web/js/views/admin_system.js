// Admin: how the server reaches Claude, which models users may pick, and the Telegram bot.

import { refreshStatus } from '../status.js';
import { api, busy, field, h, toast } from '../ui.js';

export async function systemView(root) {
  const settings = await api('GET', '/admin/settings');
  const models = settings.models.map((m) => ({ ...m }));

  // Secrets are never sent back to the browser. null = keep what is stored.
  const secrets = { anthropic_api_key: null, telegram_bot_token: null };
  const secretInput = (key, hint, placeholder) => {
    const input = h('input', {
      type: 'password',
      autocomplete: 'off',
      placeholder: hint ? `Saved (${hint}) — leave blank to keep it` : placeholder,
      oninput: (e) => (secrets[key] = e.target.value || null),
    });
    const remove = hint
      ? h('button', {
          type: 'button',
          class: 'danger ghost',
          onclick: () => {
            secrets[key] = '';
            input.value = '';
            input.placeholder = 'Will be removed when you save';
          },
        }, 'Remove')
      : null;
    return h('div', { class: 'row tight grow' }, input, remove);
  };

  const mode = (value, title, text) =>
    h(
      'label',
      { class: 'option' },
      h('input', { type: 'radio', name: 'auth_mode', value, checked: settings.auth_mode === value, onchange: () => (settings.auth_mode = value) }),
      h('span', null, h('strong', null, title), h('span', { class: 'hint' }, text)),
    );

  // ---- models users may choose
  const modelRows = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
  const defaultSelect = h('select', { onchange: (e) => (settings.default_model = e.target.value) });
  function renderModels() {
    modelRows.replaceChildren(
      ...models.map((m, index) =>
        h(
          'div',
          { class: 'model-row' },
          h('input', { type: 'text', class: 'code', value: m.id, placeholder: 'model id, e.g. claude-sonnet-5-5', oninput: (e) => { m.id = e.target.value.trim(); renderDefault(); } }),
          h('input', { type: 'text', value: m.label, placeholder: 'Label shown to users', oninput: (e) => (m.label = e.target.value) }),
          h('span', { class: `badge ${m.id === settings.default_model ? 'accent' : ''}`, style: 'visibility:' + (m.id === settings.default_model ? 'visible' : 'hidden') }, 'default'),
          h('button', {
            class: 'icon danger ghost',
            type: 'button',
            title: 'Remove this model',
            disabled: models.length === 1,
            onclick: () => {
              models.splice(index, 1);
              if (!models.some((x) => x.id === settings.default_model)) settings.default_model = models[0].id;
              renderModels();
            },
          }, '×'),
        ),
      ),
    );
    renderDefault();
  }
  function renderDefault() {
    const ids = models.map((m) => m.id).filter(Boolean);
    defaultSelect.replaceChildren(...ids.map((id) => h('option', { value: id }, id)));
    if (ids.includes(settings.default_model)) defaultSelect.value = settings.default_model;
    else if (ids.length) settings.default_model = defaultSelect.value = ids[0];
  }
  defaultSelect.addEventListener('change', renderModels);

  const effort = h('select', { value: settings.default_effort, onchange: (e) => (settings.default_effort = e.target.value) },
    h('option', { value: '' }, 'Model default'),
    ...['low', 'medium', 'high', 'xhigh', 'max'].map((level) => h('option', { value: level }, level)));
  const listen = h('input', { type: 'checkbox', checked: settings.telegram_listener_enabled, onchange: (e) => (settings.telegram_listener_enabled = e.target.checked) });
  const claudeResult = h('div', { class: 'result' });
  const telegramResult = h('div', { class: 'result' });

  async function save() {
    await api('PUT', '/admin/settings', {
      auth_mode: settings.auth_mode,
      default_model: settings.default_model,
      default_effort: settings.default_effort,
      models: models.filter((m) => m.id),
      telegram_listener_enabled: settings.telegram_listener_enabled,
      ...secrets,
    });
    await refreshStatus();
  }

  // Tests run against what is on screen, so they save first.
  const testClaude = (event) =>
    busy(event.target, async () => {
      await save();
      event.target.textContent = 'Asking Claude…';
      claudeResult.className = 'result';
      claudeResult.textContent = '';
      const r = await api('POST', '/admin/test-claude');
      claudeResult.className = `result ${r.ok ? 'ok' : 'bad'}`;
      claudeResult.textContent = r.ok
        ? `Connected. Model ${r.model} · Claude Code ${r.cli_version} · ${r.auth_source === 'none' ? 'using the Claude login on this server' : `auth: ${r.auth_source}`} · ${(r.duration_ms / 1000).toFixed(1)}s`
        : r.error;
    });
  const testTelegram = (event) =>
    busy(event.target, async () => {
      await save();
      const r = await api('POST', '/admin/test-telegram');
      telegramResult.className = `result ${r.ok ? 'ok' : 'bad'}`;
      telegramResult.textContent = r.ok ? `Connected to @${r.username} (${r.name}).` : r.error;
    });
  const saveAll = (event) =>
    busy(event.target, async () => {
      await save();
      toast('Settings saved', 'ok');
      window.dispatchEvent(new Event('hashchange')); // re-render so saved secrets show as saved
    });

  root.append(
    h('div', { class: 'title' }, h('div', null, h('h1', null, 'Claude & Telegram'), h('div', { class: 'sub' }, 'Server-wide settings. Users only choose among the models you enable here.')), h('button', { class: 'primary', onclick: saveAll }, 'Save settings')),

    h('h2', null, 'How this server reaches Claude'),
    h(
      'section',
      { class: 'panel' },
      mode('api_key', 'Anthropic API key', 'Pay-per-use billing through the Claude Console. Administrators can always generate answers; other users can once you accept their request under Users. This is the mode for serving other people.'),
      mode('subscription', 'Personal Claude subscription (Pro / Max)', 'Uses the Claude Code login on this server. A personal subscription is for its owner only, so in this mode only administrator accounts can generate answers; other users are told to ask you for API-key mode.'),
      field('API key', secretInput('anthropic_api_key', settings.anthropic_api_key_hint, 'sk-ant-…'), 'Used in API key mode. Stored in this server’s database.'),
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: testClaude }, 'Save & test Claude'), claudeResult),
    ),

    h('h2', null, 'Models users can choose'),
    h(
      'section',
      { class: 'panel' },
      h('p', { class: 'hint' }, 'A user’s account and each workflow step can pick any model on this list. A model that is not on it falls back to the default. “opus”, “sonnet” and “haiku” follow the newest version the server’s Claude Code supports.'),
      modelRows,
      h('div', null, h('button', { type: 'button', class: 'small', onclick: () => { models.push({ id: '', label: '' }); renderModels(); } }, '+ Add model')),
      h(
        'div',
        { class: 'row' },
        field('Default model', defaultSelect, 'Used when neither the user nor the step chose one.'),
        field('Default effort', effort, 'Lower is faster. “low” suits live answers.'),
      ),
    ),

    h('h2', null, 'Telegram bot'),
    h(
      'section',
      { class: 'panel' },
      h('p', { class: 'hint' }, 'One bot serves every user. Each user puts their own chat ID on their profile; answers go to that chat, and questions sent from it are answered with that profile.'),
      h(
        'ol',
        { class: 'howto' },
        h('li', null, 'In Telegram, open @BotFather, send /newbot, and copy the token it gives you.'),
        h('li', null, 'Paste the token below and save.'),
        h('li', null, 'Users open the bot and send /start; it replies with their chat ID.'),
      ),
      field('Bot token', secretInput('telegram_bot_token', settings.telegram_bot_token_hint, '123456789:AA…'), 'Stored in this server’s database.'),
      h('label', { class: 'check' }, listen, 'Listen for questions sent to the bot and reply with answers'),
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: testTelegram }, 'Save & test bot'), telegramResult),
    ),
  );
  renderModels();
  return undefined;
}
