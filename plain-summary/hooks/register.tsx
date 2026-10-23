import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Step, Summary, Tab, Turn } from '../types'

const PANE = 'plain-summary'
const TITLE = 'Plain summary'
// How many turns the timeline shows at first, and how many more "Show older" adds.
const TIMELINE_PAGE = 5

const steps = atom({ plugin: 'plain-summary', key: 'steps' } as const, [])
const summaries = atom({ plugin: 'plain-summary', key: 'summaries' } as const, [])
const turn = atom({ plugin: 'plain-summary', key: 'turn' } as const, null)
const turns = atom({ plugin: 'plain-summary', key: 'turns' } as const, [])
const isSummarizing = atom({ plugin: 'plain-summary', key: 'isSummarizing' } as const, false)
const shown = atom({ plugin: 'plain-summary', key: 'shown' } as const, 0)
const tab = atom({ plugin: 'plain-summary', key: 'tab' } as const, 'summary' as Tab)
const timelineTurns = atom({ plugin: 'plain-summary', key: 'timelineTurns' } as const, TIMELINE_PAGE)

// The live feed: a cheap model turns each raw tool call into one plain line.
const NARRATOR = 'haiku'
const NARRATE_DELAY_MS = 1500
// A turn this small (no tool calls, a short answer) gets no summary of its own.
const SMALL_ANSWER = 600

const STE_RULES = `Write in ASD-STE100 Simplified Technical English:
- Short sentences, 20 words at most. One fact per sentence.
- Active voice. Present or past tense. Common words.
- The reader is learning to code. Explain, do not show off.`

const SUMMARY_PROMPT = `Stop. Do not continue the task and do not use tools.
Write a short summary for the user of your most recent turn only (from the user's last message to your last answer).

${STE_RULES}

Use this Markdown layout and nothing else:

**You asked:** one sentence.

**What I did**
1. Up to 6 numbered steps, each one sentence.

**Why:** 1 to 3 sentences about the reasons for the approach.

**Result:** what changed, what works, and what is not done or not checked.

**Words to know**
- **term**: one plain sentence. Give 2 to 4 technical terms from this turn. Leave this section out if there are none.

No code blocks longer than 3 lines.`

// The tool fields worth showing before the narrator has written its line.
const TARGET_FIELDS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill']
const ENVELOPE_FIELDS = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta'])

function rawLine(e: Record<string, unknown>): string {
  const tool = String(e.tool)
  const target = TARGET_FIELDS.map(field => e[field]).find(value => typeof value === 'string')

  return target === undefined ? tool : `${tool}: ${String(target).replace(/\s+/g, ' ').slice(0, 120)}`
}

function toolArgs(e: Record<string, unknown>): string {
  const args = Object.fromEntries(Object.entries(e).filter(([field]) => !ENVELOPE_FIELDS.has(field)))

  return JSON.stringify(args).slice(0, 400)
}

// 24-hour local time, so every row of the timeline lines up.
function clockTime(ms: number): string {
  const d = new Date(ms)

  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

// History is saved to the mod's store (a file on disk) per session, so it
// survives an app restart. Only the most recent sessions are kept.
const KEEP_SESSIONS = 20
const SAVE_DELAY_MS = 1000
type Saved = { steps: Step[]; summaries: Summary[]; turns: Turn[] }

let historyKey: string | undefined
let saveTimer: { cancel: () => void } | undefined

async function restore($: EngineInterface) {
  const id = await $.session.id()
  historyKey = `history:${id}`
  const index = ((await $.store.get('sessions')) as string[] | undefined) ?? []
  const kept = [...index.filter(one => one !== id), id]
  for (const old of kept.slice(0, -KEEP_SESSIONS)) await $.store.delete(`history:${old}`)
  await $.store.set('sessions', kept.slice(-KEEP_SESSIONS))

  // A hot reload keeps the session's state; only an empty one is filled from disk.
  if ((await read($, turns)).length > 0) return
  const saved = (await $.store.get(historyKey)) as Saved | undefined
  if (saved === undefined) return
  await update($, steps, () => saved.steps)
  await update($, summaries, () => saved.summaries)
  await update($, turns, () => saved.turns)
}

function scheduleSave($: EngineInterface) {
  saveTimer?.cancel()
  saveTimer = $.clock.after(SAVE_DELAY_MS, () => void save($))
}

async function save($: EngineInterface) {
  saveTimer = undefined
  if (historyKey === undefined) return
  const saved: Saved = { steps: await read($, steps), summaries: await read($, summaries), turns: await read($, turns) }
  await $.store.set(historyKey, saved)
}

// Module variables start over on a reload; only the narrator's guard lives here.
let isNarrating = false
let narrateTimer: { cancel: () => void } | undefined
const argsById = new Map<string, string>()

async function narrate($: EngineInterface) {
  narrateTimer = undefined
  if (isNarrating) return
  isNarrating = true
  try {
    const pending = (await read($, steps)).filter(step => step.plain === undefined).slice(-12)
    if (pending.length === 0) return
    const current = await read($, turn)
    const list = pending
      .map((step, i) => `${i + 1}. ${step.isHelper ? '(helper agent) ' : ''}${argsById.get(step.id) ?? step.raw}`)
      .join('\n')
    const reply = await $.model.complete({
      model: NARRATOR,
      effort: 'low',
      maxTokens: 600,
      system: `You narrate what an AI coding assistant is doing, for a person who is learning to code.\n${STE_RULES}`,
      prompt: `The user asked: ${(current?.ask ?? '').slice(0, 500)}\n\nThe assistant just made these tool calls:\n${list}\n\nFor each call, write one plain sentence that says what the assistant does and, if clear, why. Begin with a verb ("Reads", "Runs", "Changes"). Answer with exactly ${pending.length} lines, numbered like the input, nothing else.`,
    })
    const lines = reply.isAnswered
      ? reply.text
          .split('\n')
          .map((line: string) => line.trim())
          .filter((line: string) => /^\d+[.)]/.test(line))
          .map((line: string) => line.replace(/^\d+[.)]\s*/, ''))
      : []
    await update($, steps, list =>
      list.map(step => {
        const at = pending.findIndex(one => one.id === step.id)

        return at < 0 ? step : { ...step, plain: lines[at] ?? step.raw }
      }),
    )
    for (const step of pending) argsById.delete(step.id)
    scheduleSave($)
  } finally {
    isNarrating = false
  }
  // Calls that came in while this batch ran get their own batch.
  if ((await read($, steps)).some(step => step.plain === undefined)) scheduleNarrate($)
}

function scheduleNarrate($: EngineInterface) {
  narrateTimer?.cancel()
  narrateTimer = $.clock.after(NARRATE_DELAY_MS, () => void narrate($))
}

async function summarize($: EngineInterface, turnId: string, ask: string) {
  await update($, isSummarizing, () => true)
  try {
    const reply = await $.model.fork({ prompt: SUMMARY_PROMPT })
    const text = reply.isAnswered
      ? reply.text.trim()
      : `_No summary: ${reply.reason}._`
    const summary: Summary = { turnId, ask, text, at: await $.clock.now() }
    await update($, summaries, list => [...list, summary].slice(-30))
    await update($, shown, () => 0)
    scheduleSave($)
  } finally {
    await update($, isSummarizing, () => false)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'plain',
      description: 'Open the plain summary pane; "/plain now" summarizes the last turn',
      argumentHint: '[now]',
    })
    await restore($)
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'plain' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: TITLE })
    if (e.args.trim() !== 'now') return { text: 'Plain summary pane opened.' }
    const current = await read($, turn)
    $.clock.after(0, () => void summarize($, current?.id ?? 'manual', current?.ask ?? ''))

    return { text: 'Plain summary pane opened. A summary of the last turn is on its way.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text !== '') {
      const fresh: Turn = { id: e.turnId, ask: e.text, steps: 0, at: await $.clock.now() }
      await update($, turn, () => fresh)
      await update($, turns, list => [...list, fresh].slice(-50))
      scheduleSave($)
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const current = await read($, turn)
    if (current !== null) {
      const fields = e as unknown as Record<string, unknown>
      const step: Step = {
        id: e.tool_use_id,
        turnId: current.id,
        raw: rawLine(fields),
        isHelper: e.agentId !== undefined,
        at: await $.clock.now(),
      }
      argsById.set(step.id, `${e.tool} ${toolArgs(fields)}`)
      await update($, steps, list => [...list, step].slice(-300))
      await update($, turn, t => (t === null ? t : { ...t, steps: t.steps + 1 }))
      scheduleNarrate($)
      scheduleSave($)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.answer === '') return done
    const current = await read($, turn)
    const isSmall = (current?.steps ?? 0) === 0 && e.answer.length < SMALL_ANSWER
    if (current !== null && !isSmall) {
      // The fork needs the turn fully ended, so it starts just after this hook.
      $.clock.after(250, () => void summarize($, current.id, current.ask))
    }

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const list = await read($, summaries)
    const back = Math.min(await read($, shown), Math.max(0, list.length - 1))
    const summary = list[list.length - 1 - back]
    const busy = await read($, isSummarizing)
    const current = await read($, turn)
    const allSteps = await read($, steps)
    const active = await read($, tab)
    const latest = allSteps[allSteps.length - 1]

    // A timeline row: the time, a glyph on the rail, then the words.
    const row = (key: string, at: number, glyph: string, words: string, dim = false, bold = false) => (
      <Box key={key} flexDirection="row" gap={1}>
        <Box width={8} flexShrink={0}>
          <Text dimColor>{clockTime(at)}</Text>
        </Box>
        <Box width={1} flexShrink={0}>
          <Text dimColor={dim}>{glyph}</Text>
        </Box>
        <Box flexShrink={1}>
          <Text dimColor={dim} bold={bold}>
            {words}
          </Text>
        </Box>
      </Box>
    )

    const tabs = (
      <Box flexDirection="row" gap={1}>
        <Button
          key="tab-summary"
          label="Summary"
          variant={active === 'summary' ? 'primary' : 'secondary'}
          onPress={() => update($, tab, () => 'summary')}
        />
        <Button
          key="tab-timeline"
          label={`Timeline (${allSteps.length})`}
          variant={active === 'timeline' ? 'primary' : 'secondary'}
          onPress={() => update($, tab, () => 'timeline')}
        />
      </Box>
    )

    if (active === 'timeline') {
      const allTurns = await read($, turns)
      const limit = await read($, timelineTurns)
      const visible = allTurns.slice(-limit).reverse()

      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          {busy && <Text dimColor>Writing a summary of the last turn…</Text>}
          {visible.length === 0 && <Text dimColor>The timeline starts with your next message.</Text>}
          {visible.map(one => {
            const ownSteps = allSteps.filter(step => step.turnId === one.id)
            const at = list.findIndex(s => s.turnId === one.id)
            const done = list[at]

            return (
              <Box key={`turn-${one.id}`} flexDirection="column">
                {row(`ask-${one.id}`, one.at, '◆', `You: ${one.ask.replace(/\s+/g, ' ').slice(0, 160)}`, false, true)}
                {ownSteps.map(step =>
                  row(
                    `step-${step.id}`,
                    step.at,
                    step.plain === undefined ? '○' : step.isHelper ? '↳' : '●',
                    step.plain ?? step.raw,
                    step.plain === undefined,
                  ),
                )}
                {ownSteps.length === 0 && row(`none-${one.id}`, one.at, '│', 'No tool calls.', true)}
                {done !== undefined && (
                  <Box flexDirection="row" gap={1}>
                    <Box width={8} flexShrink={0}>
                      <Text dimColor>{clockTime(done.at)}</Text>
                    </Box>
                    <Box width={1} flexShrink={0}>
                      <Text>✓</Text>
                    </Box>
                    <Button
                      key={`read-${one.id}`}
                      label="Read summary"
                      onPress={async () => {
                        await update($, shown, () => list.length - 1 - at)
                        await update($, tab, () => 'summary')
                      }}
                    />
                  </Box>
                )}
              </Box>
            )
          })}
          {allTurns.length > limit && (
            <Button
              key="show-older"
              label="Show older turns"
              onPress={() => update($, timelineTurns, n => n + TIMELINE_PAGE)}
            />
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {busy && <Text dimColor>Writing a summary of the last turn…</Text>}
        {latest !== undefined && current !== null && latest.turnId === current.id && (
          <Box flexDirection="column">
            <Text bold>Now</Text>
            {row('now', latest.at, latest.plain === undefined ? '○' : '●', latest.plain ?? latest.raw, latest.plain === undefined)}
          </Box>
        )}

        <Box flexDirection="column">
          <Text bold>
            Summary{summary !== undefined ? ` · ${clockTime(summary.at)}` : ''}
            {list.length > 1 ? ` (${back + 1} of ${list.length}, newest first)` : ''}
          </Text>
          {summary === undefined ? (
            <Text dimColor>A summary shows here after Claude finishes a turn.</Text>
          ) : (
            <Markdown key={`summary-${summary.turnId}-${summary.at}`} text={summary.text} />
          )}
        </Box>

        <Box flexDirection="row" gap={1}>
          {back < list.length - 1 && (
            <Button key="older" label="Older" onPress={() => update($, shown, n => n + 1)} />
          )}
          {back > 0 && <Button key="newer" label="Newer" onPress={() => update($, shown, n => n - 1)} />}
          {summary !== undefined && (
            <Button
              key="copy"
              label="Copy"
              onPress={press => void $.ui.copy({ text: summary.text, surface: press.surface })}
            />
          )}
          {summary === undefined && current !== null && (
            <Button key="now-summary" label="Summarize now" onPress={() => void summarize($, current.id, current.ask)} />
          )}
        </Box>
      </Box>
    )
  })
}
