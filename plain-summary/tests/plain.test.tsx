import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'plain-summary',
  component: 'Pane',
  requestId: 'plain-summary',
  props: {
    title: 'Plain summary',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

test('a turn shows plain steps, then a summary, on every surface', async ($, on) => {
  // Each hook here stands for the engine beneath the plugin.
  const clock = mock.clock(on)
  const forks: string[] = []
  on('command.register', () => ({ value: { command: 'plain' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: '1. Reads the login file to find the password check.', usage: USAGE },
  }))
  on('model.fork', (_, e) => {
    forks.push(e.prompt)

    return { value: { isAnswered: true, text: '**You asked:** fix the login.', usage: USAGE } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'fix the login', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/app/login.ts' })
  await clock.advance(2000)
  await $.turn.complete({ answer: 'Done. '.repeat(200), turnId: 't1', durationMs: 1, isAborted: false, reason: 'answer' })
  await clock.advance(1000)

  expect(forks.length).toBe(1)
  expect(forks[0]).toContain('Simplified Technical English')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Reads the login file/ }))?.text).toContain('Reads the login file')
    expect(await ui.find({ type: 'Markdown', text: /fix the login/ })).toBeDefined()
    await ui.unmount()
  }

  // The timeline lists the turn, then its step, each with a time.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-timeline' })
  expect((await ui.find({ type: 'Text', text: /You: fix the login/ }))?.text).toBe('You: fix the login')
  expect(await ui.find({ type: 'Text', text: /^\d\d:\d\d:\d\d$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'read-t1' })).toBeDefined()
  await ui.unmount()
})

test('a small chat turn gets no summary', async ($, on) => {
  const clock = mock.clock(on)
  let forks = 0
  on('command.register', () => ({ value: { command: 'plain' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('model.fork', () => {
    forks += 1

    return { value: { isAnswered: true, text: 'x', usage: USAGE } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: 'Hello!', turnId: 't1', durationMs: 1, isAborted: false, reason: 'answer' })
  await clock.advance(1000)

  expect(forks).toBe(0)
})

test('a restarted session gets its saved history back', async ($, on) => {
  const disk: Record<string, unknown> = {
    'history:s1': {
      steps: [{ id: 'a', turnId: 't0', raw: 'Read: x', plain: 'Reads the saved file.', isHelper: false, at: 0 }],
      summaries: [{ turnId: 't0', ask: 'old ask', text: '**You asked:** the old thing.', at: 0 }],
      turns: [{ id: 't0', ask: 'old ask', steps: 1, at: 0 }],
    },
  }
  on('session.id', () => ({ value: 's1' }))
  on('store.get', (_, e) => ({ value: disk[e.key] }))
  on('store.set', (_, e) => {
    disk[e.key] = e.value

    return { value: undefined }
  })
  on('store.delete', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'plain' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(disk.sessions).toEqual(['s1'])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Markdown', text: /the old thing/ })).toBeDefined()
  await ui.press({ key: 'tab-timeline' })
  expect((await ui.find({ type: 'Text', text: /Reads the saved file/ }))?.text).toBe('Reads the saved file.')
  await ui.unmount()
})
