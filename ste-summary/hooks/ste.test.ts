import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'old prompt', toolUses: [] },
  { role: 'assistant', text: 'old answer', toolUses: [] },
  { role: 'user', text: 'Fix the login bug', toolUses: [] },
  { role: 'assistant', text: 'I read auth.ts.', toolUses: [] },
  { role: 'user', text: '', toolUses: [], toolResults: [] },
  { role: 'assistant', text: 'I fixed the null check.', toolUses: [] },
]

const TURN = {
  answer: 'I fixed the null check.',
  durationMs: 1000,
  isAborted: false,
  turnId: 't1',
  reason: 'answer',
} as const

function engine(on: On, prompts: string[], store: Record<string, unknown> = {}) {
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', (_, e) => {
    prompts.push(String(e.prompt))
    return {
      value: {
        isAnswered: true,
        text: 'STE: The user asked for a **fix**.\n\n- The assistant changed `auth.ts`.\n2. The test passed.',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  mock.store(on, store)
}

test('a main-loop answer gets an STE summary of the latest exchange', async ($, on) => {
  const prompts: string[] = []
  engine(on, prompts)

  const done = await $.turn.complete(TURN)

  expect(done.text).toBe(
    'STE: The user asked for a fix. · The assistant changed auth.ts. · The test passed.',
  )
  expect(prompts[0]).toContain('Fix the login bug')
  expect(prompts[0]).toContain('I fixed the null check.')
  expect(prompts[0]).not.toContain('old prompt')
})

test('subagent and interrupted turns keep their answer', async ($, on) => {
  engine(on, [])

  expect((await $.turn.complete({ ...TURN, agentId: 'a1' })).text).toBe(TURN.answer)
  const aborted = await $.turn.complete({ ...TURN, reason: 'aborted', isAborted: true })
  expect(aborted.text).toBe(TURN.answer)
})

test('/ste off keeps the answer', async ($, on) => {
  engine(on, [], { enabled: false })

  expect((await $.turn.complete(TURN)).text).toBe(TURN.answer)
})
