import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteResult, On } from 'claude-code'

const PANE = {
  plugin: 'plain-summary',
  component: 'Pane',
  requestId: 'plain-summary',
  props: {
    title: 'Plain summary',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SUMMARY = JSON.stringify({
  outcome: 'Neither PR merged. A safety check blocked it.',
  groups: [
    { title: 'Checked both PRs', status: 'ok', tools: [0] },
    { title: 'Tried to merge both PRs', status: 'blocked', note: 'No review on either PR.', tools: [1] },
  ],
  reply: ['You must merge each PR yourself.'],
  terms: [{ term: 'PR', meaning: 'A request to add changes to a project.' }],
})

// Everything beneath the plugin: each hook here stands for the engine.
// A null model text stands for a model call that fails.
function engine(on: On, modelText: string | null = SUMMARY) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const calls = { model: 0 }
  on('command.register', () => ({ value: { command: 'plain' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('model.complete', () => {
    calls.model += 1
    // Only the fields the plugin reads; usage is not one of them.
    const value = (
      modelText === null
        ? { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error' }
        : { isAnswered: true, text: modelText }
    ) as ModelCompleteResult
    return { value }
  })

  return { clock, calls }
}

async function say($: Engine, text: string, uuid: string) {
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid,
  })
}

async function finish($: Engine, clock: { advance: (ms: number) => Promise<void> }) {
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  await clock.advance(500)
}

async function pane($: Engine, surface: 'terminal' | 'desktop') {
  return $.ui.mount({ ...PANE, surface })
}

test('each message of yours starts a fold; notifications and reminders do not', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.prompt.submit({ text: 'Merge both PRs please', origin: { kind: 'composer' }, wait: false })
  await $.prompt.submit({ text: '<task-notification>done</task-notification>', origin: { kind: 'task-notification' }, wait: false })
  await $.prompt.submit({ text: '<bash-input>gh pr merge 466</bash-input><bash-stdout>Merged</bash-stdout>', origin: { kind: 'sdk' }, wait: false })
  await $.prompt.submit({ text: '<system-reminder>internal</system-reminder>', origin: { kind: 'sdk' }, wait: false })
  await clock.advance(10)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await pane($, surface)
    expect(await ui.find({ type: 'Text', text: /Merge both PRs please/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /You ran a command: gh pr merge 466/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /task-notification|internal/ })).toBeFalsy()
    await ui.unmount()
  }
})

test('a finished fold shows its outcome, and a blocked group opens itself', async ($, on) => {
  const { clock, calls } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Merge both PRs', origin: { kind: 'composer' }, wait: false })
  await $.tool.call({ tool: 'Bash', command: 'gh pr view 466', description: 'Check PR 466' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr merge 466', description: 'Merge PR 466' })
  await say($, 'I could not merge. Auto mode blocked it because there is no review. You must merge each PR yourself.', 'row-1')
  await finish($, clock)

  expect(calls.model).toBe(1)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await pane($, surface)
    expect(await ui.find({ type: 'Text', text: /→ Neither PR merged/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /No review on either PR/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /You must merge each PR yourself/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('a short chat answer is summarised without a model call', async ($, on) => {
  const { clock, calls } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'what model is used?', origin: { kind: 'composer' }, wait: false })
  await say($, 'Haiku writes the summaries. You can change it with a command.', 'row-2')
  await finish($, clock)

  expect(calls.model).toBe(0)
  const ui = await pane($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /→ Haiku writes the summaries\./ })).toBeTruthy()
  await ui.unmount()
})

test('a model that fails falls back to Claude\'s own first sentence', async ($, on) => {
  const { clock } = engine(on, null)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'run the tests', origin: { kind: 'composer' }, wait: false })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })
  await say($, 'All 12 tests pass. Nothing else changed.', 'row-3')
  await finish($, clock)

  const ui = await pane($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /→ All 12 tests pass\./ })).toBeTruthy()
  await ui.unmount()
})

test('only the newest fold is open; Open all opens the rest', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'first ask', origin: { kind: 'composer' }, wait: false })
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' })
  await say($, 'Listed the files. There are three of them in the folder now.', 'row-4')
  await finish($, clock)
  await $.prompt.submit({ text: 'second ask', origin: { kind: 'composer' }, wait: false })
  await $.tool.call({ tool: 'Bash', command: 'pwd', description: 'Show folder' })
  await say($, 'You are in the project folder. Nothing else changed in it.', 'row-5')
  await finish($, clock)

  const ui = await pane($, 'desktop')
  // The groups of a fold show only when it is open; the model answer names "Checked both PRs".
  const before = await ui.findAll({ type: 'Text', text: /You must merge each PR yourself/ })
  expect(before.length).toBe(1)
  await ui.press({ key: 'all' })
  const after = await ui.findAll({ type: 'Text', text: /You must merge each PR yourself/ })
  expect(after.length).toBe(2)
  await ui.unmount()
})

test('/plain model stores the choice', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const run = (args: string) =>
    $.command.run({ command: 'plain', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  const set = await run('model sonnet')
  expect(set.text).toBe('New summaries use sonnet.')
  const bad = await run('model gpt')
  expect(bad.text).toMatch(/Summary model: sonnet/)
})
