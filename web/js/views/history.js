import { runCard, SOURCE_LABELS } from '../runcard.js';
import { api, confirmDialog, formatTime, h, modal, seconds, toast } from '../ui.js';

export async function historyView(root) {
  const body = h('tbody');
  const empty = h('div', { class: 'empty', hidden: true }, h('p', null, 'No answers yet. Ask a question on the Ask page or send one to your bot in Telegram.'));

  function open(run) {
    const card = runCard(run, { onChange: refresh });
    const close = modal({
      title: 'Answer',
      wide: true,
      body: card.el,
      onClose: () => card.destroy(),
      actions: [
        h('button', {
          class: 'danger ghost',
          onclick: async () => {
            try {
              await api('DELETE', `/runs/${run.id}`);
              close();
              await refresh();
            } catch (error) {
              toast(error.message, 'error');
            }
          },
        }, 'Delete'),
        h('button', { onclick: () => close() }, 'Close'),
      ],
    });
  }

  async function refresh() {
    const runs = await api('GET', '/runs?limit=200');
    empty.hidden = runs.length > 0;
    body.replaceChildren(
      ...runs.map((run) =>
        h(
          'tr',
          { class: 'click', onclick: () => open(run), tabIndex: 0, onkeydown: (e) => e.key === 'Enter' && open(run) },
          h('td', { class: 'nowrap muted' }, formatTime(run.created_at)),
          h('td', null, run.profile_name),
          h('td', { class: 'question' }, run.question),
          h('td', { class: 'muted' }, run.workflow_name),
          h('td', null, SOURCE_LABELS[run.source] || run.source),
          h('td', null, h('span', { class: `badge ${run.status === 'done' ? 'ok' : run.status === 'error' ? 'bad' : ''}` }, run.status)),
          h('td', { class: 'nowrap muted' }, seconds(run.duration_ms)),
          h('td', { class: 'muted' }, run.telegram_status.startsWith('failed') ? h('span', { class: 'warn', title: run.telegram_status }, 'failed') : run.telegram_status),
        ),
      ),
    );
  }

  root.append(
    h(
      'div',
      { class: 'title' },
      h('h1', null, 'History'),
      h('button', {
        class: 'danger ghost',
        onclick: async () => {
          if (!(await confirmDialog('Delete every answer in the history?', 'Clear history'))) return;
          try {
            await api('DELETE', '/runs');
            await refresh();
          } catch (error) {
            toast(error.message, 'error');
          }
        },
      }, 'Clear history'),
    ),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null, ['When', 'Profile', 'Question', 'Workflow', 'From', 'Status', 'Time', 'Telegram'].map((t) => h('th', null, t)))),
        body,
      ),
    ),
    empty,
  );
  await refresh();
  return undefined;
}
