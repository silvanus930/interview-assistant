// One run (question + step outputs), rendered live while it streams.

import { api, busy, copyText, formatTime, h, mount, seconds, toast } from './ui.js';

function telegramBadge(status) {
  if (!status) return null;
  if (status === 'sent') return h('span', { class: 'badge ok' }, 'Telegram: sent');
  if (status.startsWith('failed')) return h('span', { class: 'badge bad', title: status }, 'Telegram: failed');
  return h('span', { class: 'badge' }, `Telegram: ${status}`);
}

export const SOURCE_LABELS = { ui: 'UI', telegram: 'Telegram', extension: 'Extension' };

export function runCard(initial, { onChange } = {}) {
  const el = h('article', { class: 'run' });
  let run = initial;
  let source = null;
  let outputEls = [];
  let retries = 0;

  function stepBlock(step, index, isLast) {
    const output = h('div', { class: 'output' }, step.output || '');
    outputEls[index] = output;
    const running = step.status === 'running';
    if (running && !step.output) output.append(h('span', { class: 'thinking' }, 'Thinking…'));
    if (isLast && run.steps.length === 1) return h('div', { class: 'answer' }, output);
    const meta = [step.model, seconds(step.duration_ms), step.telegram && `Telegram: ${step.telegram}`]
      .filter(Boolean)
      .join(' · ');
    return h(
      'details',
      { class: `step${isLast ? ' final' : ''}`, open: isLast || running },
      h('summary', null, h('span', { class: 'step-name' }, `${index + 1}. ${step.name}`), h('span', { class: 'muted' }, meta)),
      output,
    );
  }

  function render() {
    outputEls = [];
    const steps = run.steps || [];
    const last = steps[steps.length - 1];
    const model = last && last.model;
    const footerMeta = run.status === 'running'
      ? 'Running…'
      : [seconds(run.duration_ms), model].filter(Boolean).join(' · ');

    el.className = `run ${run.status}`;
    mount(
      el,
      h(
        'header',
        null,
        h('h3', null, run.question),
        h(
          'div',
          { class: 'badges' },
          h('span', { class: 'badge' }, `from ${SOURCE_LABELS[run.source] || run.source}`),
          h('span', { class: 'badge' }, run.workflow_name),
          run.profile_name ? h('span', { class: 'badge' }, run.profile_name) : null,
          h('span', { class: 'muted' }, formatTime(run.created_at)),
        ),
      ),
      run.context
        ? h('details', { class: 'step' }, h('summary', null, h('span', { class: 'step-name' }, 'Conversation context'), h('span', { class: 'muted' }, 'sent by the extension')), h('div', { class: 'output' }, run.context))
        : null,
      steps.map((step, index) => stepBlock(step, index, index === steps.length - 1)),
      run.status === 'running' && !steps.length ? h('div', { class: 'output' }, h('span', { class: 'thinking' }, 'Starting…')) : null,
      run.error ? h('div', { class: 'error-box' }, run.error) : null,
      h(
        'footer',
        null,
        h('span', { class: 'muted' }, footerMeta),
        telegramBadge(run.telegram_status),
        h('span', { class: 'spacer' }),
        run.final_output ? h('button', { class: 'small', onclick: () => copyText(run.final_output) }, 'Copy') : null,
        run.final_output
          ? h('button', {
              class: 'small',
              onclick: (event) =>
                busy(event.target, async () => {
                  run = await api('POST', `/runs/${run.id}/resend`);
                  render();
                  toast('Sent to Telegram');
                }),
            }, 'Send to Telegram')
          : null,
      ),
    );
  }

  function finish(finalRun) {
    run = finalRun;
    if (source) source.close();
    source = null;
    render();
    if (onChange) onChange(run);
  }

  async function recover() {
    // The stream dropped: fall back to the stored state, and re-attach if still running.
    try {
      const latest = await api('GET', `/runs/${run.id}`);
      if (latest.status === 'running' && retries++ < 20) {
        run = latest;
        setTimeout(attach, 1500);
      } else {
        finish(latest);
      }
    } catch {
      /* server unreachable; leave the card as it is */
    }
  }

  function attach() {
    if (source) source.close();
    run = { ...run, steps: [] }; // the stream replays every event from the start
    source = new EventSource(`/api/runs/${run.id}/events`);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data);
      if (event.type === 'step_start') {
        run.steps[event.index] = { name: event.name, status: 'running', output: '' };
        render();
      } else if (event.type === 'delta') {
        const step = run.steps[event.index];
        const target = outputEls[event.index];
        if (!step || !target) return;
        if (!step.output) target.replaceChildren();
        step.output += event.text;
        target.append(event.text);
      } else if (event.type === 'step_done') {
        run.steps[event.index] = event.step;
        render();
      } else if (event.type === 'done' || event.type === 'error') {
        finish(event.run);
      }
    };
    source.onerror = () => {
      if (!source) return;
      source.close();
      source = null;
      recover();
    };
  }

  render();
  if (run.status === 'running') attach();

  return {
    el,
    destroy() {
      if (source) source.close();
      source = null;
    },
  };
}
