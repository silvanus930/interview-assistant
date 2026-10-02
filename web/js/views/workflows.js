import { api, busy, confirmDialog, field, h, insertAtCursor, modal, toast } from '../ui.js';

const NEW_WORKFLOW = {
  name: '',
  description: '',
  system_prompt: '',
  telegram_template: '❓ {{question}}\n\n{{output}}',
  steps: [{ key: '', name: 'Spoken answer', prompt: 'Interview question:\n{{question}}\n\n', model: '', effort: '', send_to_telegram: true, enabled: true }],
};

// The same pages serve a user's own workflows and the admin's shared templates.
const WORKFLOWS = {
  base: '/workflows', hash: '#/workflows', title: 'Workflows', noun: 'workflow', isTemplates: false,
  lead: 'A workflow is the system prompt plus an ordered list of Claude steps. Each step’s prompt can use the résumé, the question and the output of earlier steps, and you choose which steps are sent to Telegram.',
};
const TEMPLATES = {
  base: '/admin/templates', hash: '#/templates', title: 'Templates', noun: 'template', isTemplates: true,
  lead: 'Templates are the starting workflows. Every new user gets their own copy of each one, and any user can start a new workflow from a template. Editing a template does not change copies users already have.',
};

export const templatesView = (root, param) => workflowsView(root, param, TEMPLATES);

export async function workflowsView(root, param, cfg = WORKFLOWS) {
  if (param) return editor(root, param, cfg);

  const list = h('div', { class: 'cards' });

  // Start a workflow from one of the admin's templates
  async function pickTemplate() {
    const templates = await api('GET', '/templates');
    const close = modal({
      title: 'Start from a template',
      body: templates.length
        ? templates.map((t) =>
            h('div', { class: 'card' },
              h('h3', null, t.name),
              h('p', { class: 'muted' }, t.description || 'No description'),
              h('footer', null, h('button', {
                class: 'primary',
                onclick: (event) => busy(event.target, async () => {
                  const copy = await api('POST', `/templates/${t.id}/use`);
                  close();
                  location.hash = `${cfg.hash}/${copy.id}`;
                }),
              }, 'Use this template'))))
        : h('p', { class: 'muted' }, 'Your administrator has not published any templates.'),
    });
  }

  async function refresh() {
    const workflows = await api('GET', cfg.base);
    list.replaceChildren(
      ...workflows.map((wf) => {
        const active = wf.steps.filter((s) => s.enabled !== false);
        return h(
          'article',
          { class: 'card' },
          h('h3', null, wf.name, wf.is_default ? h('span', { class: 'badge ok' }, 'default') : null),
          h('p', { class: 'muted' }, wf.description || 'No description'),
          h('ol', { class: 'steps-summary' }, active.map((s) =>
            h('li', null, s.name, s.send_to_telegram ? h('span', { class: 'badge' }, '→ Telegram') : null))),
          h(
            'footer',
            null,
            h('a', { class: 'button', href: `${cfg.hash}/${wf.id}` }, 'Edit'),
            wf.is_default
              ? null
              : h('button', {
                  onclick: (event) =>
                    busy(event.target, async () => {
                      await api('POST', `${cfg.base}/${wf.id}/default`);
                      await refresh();
                    }),
                }, 'Make default'),
            h('button', {
              onclick: (event) =>
                busy(event.target, async () => {
                  const copy = await api('POST', `${cfg.base}/${wf.id}/duplicate`);
                  location.hash = `${cfg.hash}/${copy.id}`;
                }),
            }, 'Duplicate'),
            cfg.isTemplates
              ? h('button', {
                  title: 'Add a copy of this template to every user’s workflows',
                  onclick: async (event) => {
                    if (!(await confirmDialog(`Add a copy of “${wf.name}” to every user’s workflows? Their existing workflows are not changed.`, 'Give to all users'))) return;
                    busy(event.target, async () => {
                      const result = await api('POST', `${cfg.base}/${wf.id}/distribute`);
                      toast(`Added to ${result.users} user${result.users === 1 ? '' : 's'}`, 'ok');
                    });
                  },
                }, 'Give to all users')
              : null,
            h('button', {
              class: 'danger ghost',
              onclick: async () => {
                if (!(await confirmDialog(`Delete the ${cfg.noun} “${wf.name}”?`))) return;
                try {
                  await api('DELETE', `${cfg.base}/${wf.id}`);
                  await refresh();
                } catch (error) {
                  toast(error.message, 'error');
                }
              },
            }, 'Delete'),
          ),
        );
      }),
    );
  }

  root.append(
    h('div', { class: 'title' }, h('h1', null, cfg.title), h('div', { class: 'row tight' },
      cfg.isTemplates ? null : h('button', { onclick: (event) => busy(event.target, pickTemplate) }, 'Start from a template'),
      h('a', { class: 'button primary', href: `${cfg.hash}/new` }, `New ${cfg.noun}`))),
    h('p', { class: 'muted lead' }, cfg.lead),
    list,
  );
  await refresh();
  return undefined;
}

async function editor(root, param, cfg) {
  const isNew = param === 'new';
  const [meta, profiles, loaded] = await Promise.all([
    api('GET', '/meta'),
    api('GET', '/profiles'),
    isNew ? null : api('GET', cfg.base).then((all) => all.find((w) => String(w.id) === param)),
  ]);
  if (!isNew && !loaded) {
    root.append(h('div', { class: 'empty' }, h('p', null, `This ${cfg.noun} no longer exists.`), h('a', { class: 'button', href: cfg.hash }, `Back to ${cfg.title.toLowerCase()}`)));
    return undefined;
  }

  const draft = structuredClone(loaded || NEW_WORKFLOW);
  let lastFocused = null; // the prompt box that variable chips insert into
  const track = (el) => {
    el.addEventListener('focus', () => (lastFocused = el));
    return el;
  };
  const prompt = (target, key, rows, placeholder) =>
    track(h('textarea', { class: 'code', rows, placeholder, value: target[key] || '', oninput: (e) => (target[key] = e.target.value) }));

  const chips = (variables) =>
    h('div', { class: 'chips' }, variables.map((v) =>
      h('button', {
        class: 'chip',
        type: 'button',
        title: v.description,
        // mousedown would move focus away from the prompt box before the click lands
        onmousedown: (event) => event.preventDefault(),
        onclick: () => {
          if (!lastFocused) return toast('Click into a prompt box first, then pick a variable.');
          return insertAtCursor(lastFocused, `{{${v.name}}}`);
        },
      }, `{{${v.name}}}`)));

  const stepsEl = h('div', { class: 'steps' });

  function renderSteps() {
    stepsEl.replaceChildren(
      ...draft.steps.map((step, index) => {
        const move = (delta) => () => {
          const target = index + delta;
          if (target < 0 || target >= draft.steps.length) return;
          [draft.steps[index], draft.steps[target]] = [draft.steps[target], draft.steps[index]];
          renderSteps();
        };
        const check = (key, label) =>
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: step[key] !== false && Boolean(step[key]), onchange: (e) => (step[key] = e.target.checked) }), label);
        return h(
          'section',
          { class: `panel step-editor${step.enabled === false ? ' disabled' : ''}` },
          h(
            'div',
            { class: 'row end' },
            h('span', { class: 'step-number' }, index + 1),
            field('Step name', h('input', { type: 'text', value: step.name, oninput: (e) => (step.name = e.target.value) })),
            field('Key — later steps read this output as {{steps.KEY}}', h('input', { type: 'text', value: step.key, placeholder: 'auto', oninput: (e) => (step.key = e.target.value) })),
            h('div', { class: 'row tight' },
              h('button', { class: 'icon', type: 'button', title: 'Move up', disabled: index === 0, onclick: move(-1) }, '↑'),
              h('button', { class: 'icon', type: 'button', title: 'Move down', disabled: index === draft.steps.length - 1, onclick: move(1) }, '↓'),
              h('button', {
                class: 'icon danger',
                type: 'button',
                title: 'Remove step',
                disabled: draft.steps.length === 1,
                onclick: () => {
                  draft.steps.splice(index, 1);
                  renderSteps();
                },
              }, '×')),
          ),
          field('Prompt', prompt(step, 'prompt', 9, 'What Claude should do in this step. Use {{question}}, {{previous}}, …')),
          h(
            'div',
            { class: 'row end' },
            field('Model', h('select', { value: meta.models.some((m) => m.id === step.model) ? step.model : '', onchange: (e) => (step.model = e.target.value) },
              h('option', { value: '' }, 'The user’s default'),
              ...meta.models.map((m) => h('option', { value: m.id }, m.id)))),
            field('Effort', h('select', { value: step.effort || '', onchange: (e) => (step.effort = e.target.value) },
              h('option', { value: '' }, 'The user’s default'),
              ...meta.efforts.map((level) => h('option', { value: level }, level)))),
            check('send_to_telegram', 'Send this step’s output to Telegram'),
            check('enabled', 'Enabled'),
          ),
        );
      }),
    );
  }

  function payload() {
    return {
      name: draft.name.trim(),
      description: draft.description,
      system_prompt: draft.system_prompt,
      telegram_template: draft.telegram_template,
      steps: draft.steps,
    };
  }

  function validate() {
    if (!draft.name.trim()) throw new Error(`Give the ${cfg.noun} a name.`);
    draft.steps.forEach((step, index) => {
      if (!step.name.trim()) throw new Error(`Step ${index + 1} needs a name.`);
      if (!step.prompt.trim()) throw new Error(`Step ${index + 1} needs a prompt.`);
    });
  }

  const save = (event) =>
    busy(event.target, async () => {
      validate();
      const saved = isNew ? await api('POST', cfg.base, payload()) : await api('PUT', `${cfg.base}/${loaded.id}`, payload());
      toast(cfg.isTemplates ? 'Template saved' : 'Workflow saved', 'ok');
      if (isNew) {
        location.hash = `${cfg.hash}/${saved.id}`;
      } else {
        draft.steps = saved.steps; // pick up the keys the server generated
        renderSteps();
      }
    });

  const previewProfile = h('select', null, h('option', { value: '' }, 'No profile (empty résumé)'), ...profiles.map((p) => h('option', { value: p.id }, p.name)));
  if (profiles.length) previewProfile.value = profiles[0].id;
  const previewQuestion = h('input', { type: 'text', placeholder: 'Sample question — default: Tell me about yourself.' });
  const preview = (event) =>
    busy(event.target, async () => {
      validate();
      const result = await api('POST', '/workflows/preview', {
        workflow: payload(),
        profile_id: Number(previewProfile.value) || null,
        question: previewQuestion.value,
      });
      modal({
        title: 'Exactly what Claude receives',
        wide: true,
        body: [
          h('h3', null, 'System prompt'),
          h('pre', { class: 'preview' }, result.system_prompt || '(empty)'),
          ...result.steps.flatMap((step, index) => [h('h3', null, `Step ${index + 1} — ${step.name}`), h('pre', { class: 'preview' }, step.prompt)]),
        ],
      });
    });

  root.append(
    h(
      'div',
      { class: 'title' },
      h('h1', null, h('a', { class: 'crumb', href: cfg.hash }, cfg.title), ' / ', isNew ? `New ${cfg.noun}` : loaded.name),
      h('button', { class: 'primary', onclick: save }, `Save ${cfg.noun}`),
    ),
    h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'row' },
        field('Name', h('input', { type: 'text', value: draft.name, oninput: (e) => (draft.name = e.target.value) })),
        field('Description', h('input', { type: 'text', value: draft.description, oninput: (e) => (draft.description = e.target.value) })),
      ),
      field('System prompt', prompt(draft, 'system_prompt', 14, 'Who Claude is writing for and the facts it may use. Sent with every step.'),
        'Sent with every step of this workflow. Put the résumé and the ground rules here.'),
    ),
    h(
      'section',
      { class: 'panel sticky' },
      h('span', { class: 'label' }, 'Variables — click into a prompt, then click one to insert it'),
      chips(meta.variables),
    ),
    h('h2', null, 'Steps'),
    stepsEl,
    h('button', {
      type: 'button',
      onclick: () => {
        draft.steps.push({ key: '', name: `Step ${draft.steps.length + 1}`, prompt: '{{previous}}', model: '', effort: '', send_to_telegram: false, enabled: true });
        renderSteps();
      },
    }, '+ Add step'),
    h('h2', null, 'Telegram message'),
    h(
      'section',
      { class: 'panel' },
      field('Message template', prompt(draft, 'telegram_template', 3, '{{output}}'),
        'How each sent answer is formatted. Sent as plain text; long answers are split automatically.'),
      chips(meta.telegram_variables),
    ),
    h('h2', null, 'Preview'),
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'row end' }, field('Profile', previewProfile), field('Question', previewQuestion), h('button', { type: 'button', onclick: preview }, 'Preview prompts')),
      h('p', { class: 'hint' }, 'Shows the fully rendered prompts without calling Claude. Works on unsaved changes.'),
    ),
    h('div', { class: 'row between' }, h('a', { class: 'button', href: cfg.hash }, 'Back'), h('button', { class: 'primary', onclick: save }, `Save ${cfg.noun}`)),
  );
  renderSteps();
  return undefined;
}
