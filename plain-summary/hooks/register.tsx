import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Fold, FoldKind, Group, Say, Step, Summary } from '../types'

const PANE = 'plain-summary'
const TITLE = 'Plain summary'

const folds = atom({ plugin: 'plain-summary', key: 'folds' } as const, [])
const summarizing = atom({ plugin: 'plain-summary', key: 'summarizing' } as const, [])
const opened = atom({ plugin: 'plain-summary', key: 'opened' } as const, [])
const closed = atom({ plugin: 'plain-summary', key: 'closed' } as const, [])
const openGroups = atom({ plugin: 'plain-summary', key: 'openGroups' } as const, [])
const shownCmds = atom({ plugin: 'plain-summary', key: 'shownCmds' } as const, [])

const DEFAULT_MODEL = 'haiku'
const MODELS = ['haiku', 'sonnet', 'opus']
// A fold this small (no tool calls, a short answer) gets no model call.
const SMALL_ANSWER = 600
const MAX_INPUT = 60000
const KEEP_FOLDS = 200
const KEEP_SESSIONS = 20
const SAVE_DELAY_MS = 1000

const SYSTEM = `You summarise one stretch of a coding session for a person who is learning to code.
The stretch starts with what the user did and holds everything the AI assistant did until the user's next message.
Write in ASD-STE100 Simplified Technical English: short sentences (at most 15 words), active voice, common words, one fact per sentence.
Read less, know more: say only what the user needs to keep up. Never invent facts that are not in the input.
Fidelity rule: keep every warning, prohibition and instruction to the user with the same meaning and polarity as the source.
If the assistant tells the user to do something, the reply says to do it. If it tells the user not to do something, the reply says not to.
Keep direct instructions to the user close to the source wording. Do not add safety advice of your own.

Answer with one JSON object and nothing else:
{"outcome": string, "groups": [{"title": string, "status": "ok"|"blocked"|"failed", "note"?: string, "tools": number[]}], "reply": string[]}
- outcome: one line, at most 12 words: what came of this stretch. Say if something failed or is not done.
- groups: tool calls grouped by purpose, in order, at most 5. Empty if there were no tool calls. title: at most 8 words, starts with a past-tense verb. note: only if blocked or failed, why, one sentence. tools: indexes of the tool calls in the group.
- reply: 1 to 3 lines: the assistant's message to the user, rewritten in STE. Keep anything the user must do or decide.`

// --- what the user did ---------------------------------------------------

const HUMAN_ORIGINS = new Set(['composer', 'sdk', 'bridge'])

type Classified = { kind: FoldKind; you: string } | undefined

function classify(text: string): Classified {
  const bash = text.match(/<bash-input>([\s\S]*?)<\/bash-input>/)
  if (bash) return { kind: 'ran', you: `You ran a command: ${(bash[1] ?? '').trim()}` }
  const task = text.match(/started your suggested background task[^(]*\("([^"]+)"\)/)
  if (task) return { kind: 'task', you: `You started a side task: ${task[1] ?? ''}` }
  const you = cleanText(text)
  if (you === '') return undefined

  return { kind: 'msg', you }
}

function cleanText(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content>/g, '[pasted text]')
    .replace(/<bash-(stdout|stderr)>[\s\S]*?<\/bash-\1>/g, '')
    .replace(/<\/?[a-z][\w-]*(\s[^>]*)?>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// --- recording -----------------------------------------------------------

const LABEL_FIELDS = ['description', 'file_path', 'path', 'pattern', 'query', 'url', 'skill']
const ENVELOPE_FIELDS = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta'])

function stepLabel(e: Record<string, unknown>): string {
  const tool = String(e.tool)
  const field = LABEL_FIELDS.find(name => typeof e[name] === 'string')
  if (field === undefined) return tool
  const value = String(e[field])
  const shown = field === 'description' ? value : value.split('/').pop() ?? value

  return field === 'description' ? shown : `${tool} ${shown}`
}

function stepArgs(e: Record<string, unknown>): string {
  const args = Object.fromEntries(Object.entries(e).filter(([name]) => !ENVELOPE_FIELDS.has(name)))
  if (typeof args.command === 'string') return args.command

  return JSON.stringify(args, null, 1).slice(0, 1200)
}

function textOf(content: readonly unknown[]): string {
  return content
    .map(block => (block as { type?: string; text?: string }))
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

async function current($: EngineInterface): Promise<Fold | undefined> {
  const list = await read($, folds)

  return list[list.length - 1]
}

async function changeFold($: EngineInterface, id: string, change: (fold: Fold) => Fold) {
  await update($, folds, list => list.map(fold => (fold.id === id ? change(fold) : fold)))
  scheduleSave($)
}

// --- summarising ---------------------------------------------------------

function foldText(fold: Fold): string {
  type Event = { at: number; line: string }
  const events: Event[] = [
    ...fold.steps.map((step, i): Event => ({
      at: step.at,
      line: `[tool ${i}] ${step.isHelper ? '(helper agent) ' : ''}${step.tool} ${step.args.slice(0, 400)}${
        step.result ? `\n  result: ${step.result.slice(0, 300)}` : ''
      }`,
    })),
    ...fold.says.map((say): Event => ({ at: say.at, line: `ASSISTANT SAYS: ${say.text.slice(0, 6000)}` })),
  ].sort((a, b) => a.at - b.at)
  const head = `USER (${fold.kind === 'ran' ? 'ran a shell command' : fold.kind === 'task' ? 'started a side task' : 'message'}): ${fold.you}`

  return [head, '', ...events.map(event => event.line)].join('\n').slice(0, MAX_INPUT)
}

function sentences(text: string): string[] {
  return cleanText(text.replace(/[`*_#>]/g, ''))
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s !== '')
}

function fallback(fold: Fold, model: string, at: number): Summary {
  const said = sentences(fold.says.map(say => say.text).join(' '))
  const byTool = new Map<string, number[]>()
  fold.steps.forEach((step, i) => byTool.set(step.tool, [...(byTool.get(step.tool) ?? []), i]))
  const groups: Group[] = [...byTool].map(([tool, tools]) => ({
    title: `Used ${tool}`,
    status: tools.some(i => fold.steps[i]?.isError === true) ? 'failed' : 'ok',
    tools,
  }))

  return {
    outcome: (said[0] ?? 'No reply.').slice(0, 120),
    groups: groups.slice(0, 5),
    reply: said.slice(0, 3).map(s => s.slice(0, 240)),
    terms: [],
    model,
    at,
    isFallback: true,
  }
}

function parse(text: string, fold: Fold, model: string, at: number): Summary | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    if (typeof raw.outcome !== 'string') return undefined
    const groups = (Array.isArray(raw.groups) ? raw.groups : [])
      .map(g => g as Record<string, unknown>)
      .filter(g => typeof g.title === 'string')
      .map(
        (g): Group => ({
          title: String(g.title),
          status: g.status === 'blocked' || g.status === 'failed' ? g.status : 'ok',
          note: typeof g.note === 'string' && g.note !== '' ? g.note : undefined,
          tools: (Array.isArray(g.tools) ? g.tools : []).filter(
            (i): i is number => typeof i === 'number' && i >= 0 && i < fold.steps.length,
          ),
        }),
      )
      .slice(0, 5)
    const reply = (Array.isArray(raw.reply) ? raw.reply : []).filter((l): l is string => typeof l === 'string').slice(0, 3)

    return { outcome: raw.outcome, groups, reply, terms: [], model, at }
  } catch {
    return undefined
  }
}

async function chosenModel($: EngineInterface): Promise<string> {
  const stored = await $.store.get('model')

  return typeof stored === 'string' && MODELS.includes(stored) ? stored : DEFAULT_MODEL
}

async function summarize($: EngineInterface, id: string) {
  const fold = (await read($, folds)).find(one => one.id === id)
  if (fold === undefined) return
  const model = await chosenModel($)
  const at = await $.clock.now()
  const saidLength = fold.says.reduce((n, say) => n + say.text.length, 0)
  if (fold.steps.length === 0 && saidLength < SMALL_ANSWER) {
    await changeFold($, id, one => ({ ...one, summary: { ...fallback(one, 'none', at), isFallback: false } }))
    return
  }
  await update($, summarizing, list => [...list.filter(one => one !== id), id])
  try {
    // A failed or garbled answer falls back to Claude's own words; the fold never shows an error.
    const reply = await $.model
      .complete({ model, system: SYSTEM, prompt: foldText(fold), maxTokens: 2000, effort: 'low' })
      .catch(() => undefined)
    const summary = (reply?.isAnswered ? parse(reply.text, fold, model, at) : undefined) ?? fallback(fold, model, at)
    await changeFold($, id, one => ({ ...one, summary }))
  } finally {
    await update($, summarizing, list => list.filter(one => one !== id))
  }
}

// --- saving ----------------------------------------------------------------

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
  if ((await read($, folds)).length > 0) return
  const saved = (await $.store.get(historyKey)) as { folds?: Fold[]; opened?: string[]; closed?: string[] } | undefined
  const savedFolds = saved?.folds
  if (saved === undefined || !Array.isArray(savedFolds)) return
  await update($, folds, () => savedFolds.map(fold => ({ ...fold, isWorking: false })))
  await update($, opened, () => saved.opened ?? [])
  await update($, closed, () => saved.closed ?? [])
}

function scheduleSave($: EngineInterface) {
  saveTimer?.cancel()
  saveTimer = $.clock.after(SAVE_DELAY_MS, () => void save($))
}

async function save($: EngineInterface) {
  saveTimer = undefined
  if (historyKey === undefined) return
  await $.store.set(historyKey, { folds: await read($, folds), opened: await read($, opened), closed: await read($, closed) })
}

// --- helpers for drawing --------------------------------------------------

function clockTime(ms: number): string {
  const d = new Date(ms)

  return [d.getHours(), d.getMinutes()].map(n => String(n).padStart(2, '0')).join(':')
}

const GLYPH: Record<FoldKind, string> = { msg: '●', ran: '○', task: '■' }

function toggleIn(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter(one => one !== id) : [...list, id]
}

// --- hooks ---------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'plain',
      description: 'Open the plain summary pane; "/plain model haiku|sonnet|opus" sets the model; "/plain now" re-summarises the newest fold',
      argumentHint: '[now | model <name>]',
    })
    await restore($)
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'plain' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: TITLE })
    const [word, value] = e.args.trim().split(/\s+/)
    if (word === 'model') {
      if (!MODELS.includes(value ?? '')) return { text: `Summary model: ${await chosenModel($)}. Choose one of: ${MODELS.join(', ')}.` }
      await $.store.set('model', value)
      return { text: `New summaries use ${value}.` }
    }
    if (word === 'now') {
      const fold = await current($)
      if (fold === undefined) return { text: 'Nothing to summarise yet.' }
      $.clock.after(0, () => void summarize($, fold.id))
      return { text: 'A new summary of the newest fold is on its way.' }
    }

    return { text: 'Plain summary pane opened.' }
  })

  // A fold starts with each thing the person does: a message, a shell command, a side task.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (e.command !== undefined || !HUMAN_ORIGINS.has(e.origin.kind)) return result
    const found = classify(e.text)
    if (found === undefined || (e.isMeta === true && found.kind !== 'task')) return result
    const at = await $.clock.now()
    const fold: Fold = { id: `f${at}`, kind: found.kind, at, you: found.you, steps: [], says: [], isWorking: found.kind !== 'ran' }
    await update($, folds, list => [...list, fold].slice(-KEEP_FOLDS))
    // The newest fold opens by default, so a new one clears any choice made on it.
    await update($, closed, list => list.filter(one => one !== fold.id))
    scheduleSave($)

    return result
  }).catch(($, e, next) => next(e))

  // The rows the conversation keeps: Claude's text, for summarising and "Show full reply".
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId !== undefined) return stored
    const fold = await current($)
    if (fold === undefined) return stored
    if (e.door === 'prompt' && fold.rowId === undefined && HUMAN_ORIGINS.has(e.origin.kind)) {
      await changeFold($, fold.id, one => ({ ...one, rowId: e.uuid }))
    }
    if (e.door === 'response' && e.message.role === 'assistant') {
      const text = textOf(e.message.content)
      if (text !== '') {
        const say: Say = { text, rowId: e.uuid, at: await $.clock.now() }
        await changeFold($, fold.id, one => ({ ...one, says: [...one.says, say] }))
      }
    }

    return stored
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const fold = await current($)
    if (fold === undefined) return next(e)
    const fields = e as unknown as Record<string, unknown>
    const step: Step = {
      id: e.tool_use_id,
      tool: String(e.tool),
      label: stepLabel(fields),
      args: stepArgs(fields),
      isHelper: e.agentId !== undefined,
      at: await $.clock.now(),
    }
    await changeFold($, fold.id, one => ({ ...one, steps: [...one.steps, step].slice(-400) }))
    const ran = await next(e)
    const out = ran as unknown as { text?: unknown; isError?: unknown; deny?: unknown }
    const result = typeof out.text === 'string' ? out.text.slice(0, 300) : typeof out.deny === 'string' ? `Denied: ${out.deny}` : undefined
    const isError = out.isError === true || typeof out.deny === 'string'
    await changeFold($, fold.id, one => ({
      ...one,
      steps: one.steps.map(s => (s.id === step.id ? { ...s, result, isError } : s)),
    }))

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const fold = await current($)
    if (fold === undefined) return done
    await changeFold($, fold.id, one => ({ ...one, isWorking: false }))
    // The summary waits until the turn has fully ended.
    $.clock.after(250, () => void summarize($, fold.id))

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const list = await read($, folds)
    const busy = await read($, summarizing)
    const openList = await read($, opened)
    const closedList = await read($, closed)
    const groupsOpen = await read($, openGroups)
    const shown = await read($, shownCmds)
    const newest = list[list.length - 1]
    const isOpen = (fold: Fold) => (fold.id === newest?.id ? !closedList.includes(fold.id) : openList.includes(fold.id))
    const allOpen = list.length > 0 && list.every(isOpen)

    const toggleFold = (fold: Fold) =>
      fold.id === newest?.id ? update($, closed, l => toggleIn(l, fold.id)) : update($, opened, l => toggleIn(l, fold.id))

    const toggleAll = async () => {
      if (allOpen) {
        await update($, opened, () => [])
        if (newest) await update($, closed, () => [newest.id])
      } else {
        await update($, opened, () => list.map(fold => fold.id))
        await update($, closed, () => [])
      }
      scheduleSave($)
    }

    const toggleShown = (key: string) => update($, shownCmds, l => toggleIn(l, key))

    const groupView = (fold: Fold, group: Group, gi: number) => {
      const key = `${fold.id}:${gi}`
      const isProblem = group.status !== 'ok'
      const isGroupOpen = isProblem ? !groupsOpen.includes(key) : groupsOpen.includes(key)
      const steps = group.tools.map(i => fold.steps[i]).filter((s): s is Step => s !== undefined)

      return (
        <Box key={`g-${key}`} flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1}>
            <Button key={`gb-${key}`} plain onPress={() => update($, openGroups, l => toggleIn(l, key))}>
              <Text color={isProblem ? 'error' : 'success'}>{isProblem ? '!' : '✓'}</Text>
              <Text dimColor>{isGroupOpen ? ' ▾' : ' ▸'}</Text>
            </Button>
            <Box flexShrink={1} flexDirection="column">
              <Text wrap="wrap">{group.title}</Text>
              <Text dimColor size="caption">{`${steps.length} step${steps.length === 1 ? '' : 's'}`}</Text>
            </Box>
          </Box>
          {isProblem && group.note !== undefined && (
            <Box paddingLeft={4}>
              <Text color="error" wrap="wrap">
                {group.note}
              </Text>
            </Box>
          )}
          {isGroupOpen && (
            <Box flexDirection="column" paddingLeft={4} gap={1}>
              {steps.map(step => (
                <Box key={`s-${step.id}`} flexDirection="column">
                  <Text wrap="wrap">
                    <Text dimColor>{`${clockTime(step.at)}  `}</Text>
                    {step.label}
                    {step.isError ? <Text color="error">{'  (error)'}</Text> : ''}
                  </Text>
                  <Button key={`sc-${step.id}`} plain dimColor onPress={() => toggleShown(step.id)}>
                    {shown.includes(step.id) ? 'Hide command' : 'Show command'}
                  </Button>
                  {shown.includes(step.id) && (
                    <Box paddingLeft={2}>
                      <Text mono dimColor wrap="wrap">
                        {step.args}
                      </Text>
                    </Box>
                  )}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    const foldView = (fold: Fold) => {
      const isFoldOpen = isOpen(fold)
      const summary = fold.summary
      const isBusy = busy.includes(fold.id)
      const latest = fold.steps[fold.steps.length - 1]
      const problem = summary?.groups.find(g => g.status !== 'ok')
      const originalKey = `original:${fold.id}`
      const original = fold.says.map(say => say.text).join('\n\n')
      const status = fold.isWorking
        ? `Working: ${latest?.label ?? 'thinking'}`
        : isBusy
          ? 'Writing the summary…'
          : summary !== undefined
            ? `→ ${summary.outcome}`
            : fold.kind === 'ran'
              ? '→ Done.'
              : ''

      return (
        <Box key={`f-${fold.id}`} flexDirection="column" marginBottom={2} gap={1}>
          <Box flexDirection="row" gap={1}>
            <Button key={`fb-${fold.id}`} plain onPress={() => toggleFold(fold)}>
              <Text dimColor>{`${clockTime(fold.at)} `}</Text>
              <Text color={fold.id === newest?.id ? 'claude' : 'text'}>{GLYPH[fold.kind]}</Text>
              <Text dimColor>{isFoldOpen ? ' ▾' : ' ▸'}</Text>
            </Button>
            <Box flexShrink={1}>
              <Text bold={fold.kind === 'msg'} wrap="wrap">
                {fold.you.length > 300 ? `${fold.you.slice(0, 297)}…` : fold.you}
              </Text>
            </Box>
          </Box>
          <Box flexDirection="column" paddingLeft={4}>
            {fold.id === newest?.id && (
              <Text size="caption" color="claude">
                Since your last message
              </Text>
            )}
            {status !== '' && (
              <Text dimColor={fold.isWorking || isBusy} wrap="wrap">
                {status}
              </Text>
            )}
            {problem !== undefined && <Text color="error">{problem.status}</Text>}
          </Box>
          {isFoldOpen && summary !== undefined && (
            <Box flexDirection="column" paddingLeft={4} gap={1}>
              {summary.groups.map((group, gi) => groupView(fold, group, gi))}
              {summary.reply.length > 0 && (
                <Box flexDirection="column" gap={1}>
                  <Text dimColor size="caption">
                    Claude replied
                  </Text>
                  {summary.reply.map((line, li) => (
                    <Text key={`r-${fold.id}-${li}`} wrap="wrap">
                      {line}
                    </Text>
                  ))}
                </Box>
              )}
              {original !== '' && (
                <Box flexDirection="column" gap={1}>
                  <Button key={`ob-${fold.id}`} plain onPress={() => toggleShown(originalKey)}>
                    <Text color="suggestion">{shown.includes(originalKey) ? 'Hide full reply' : 'Show full reply'}</Text>
                  </Button>
                  {shown.includes(originalKey) && <Markdown key={`om-${fold.id}`} text={original} />}
                </Box>
              )}
            </Box>
          )}
          {isFoldOpen && summary === undefined && fold.steps.length > 0 && (
            <Box flexDirection="column" paddingLeft={4}>
              {fold.steps.slice(-5).map(step => (
                <Text key={`ls-${step.id}`} dimColor wrap="wrap">{`${clockTime(step.at)}  ${step.label}`}</Text>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="flex-end">
          {list.length > 0 && (
            <Button key="all" plain onPress={toggleAll}>
              <Text color="suggestion">{allOpen ? 'Fold all' : 'Open all'}</Text>
            </Button>
          )}
        </Box>
        {list.length === 0 && <Text dimColor>Your next message starts the timeline.</Text>}
        {list.map(foldView)}
      </Box>
    )
  })
}
