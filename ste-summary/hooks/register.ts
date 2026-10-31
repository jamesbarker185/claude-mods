import type { EngineInterface, Register, SessionMessage } from 'claude-code'

const ENABLED = 'enabled'
const MAX_CHARS = 24_000

const RULES = `You write summaries in ASD-STE100 Simplified Technical English (STE).

Rules:
- Use only STE approved words, each with its one approved meaning. Keep technical names (files, commands, functions, products) exactly as written.
- Write sentences of 20 words or fewer for instructions and 25 words or fewer for descriptions.
- Use the active voice and simple present or simple past tense.
- Write one instruction per sentence, in the imperative form.
- Do not use idioms, slang, contractions or "-ing" forms as nouns or adjectives.
- Use articles ("the", "a") where English permits them.

Output format: the summary shows as one line of plain text. Write one paragraph with no line breaks, no lists and no Markdown (no asterisks, underscores, backticks or headings).

Task: summarize the exchange that follows, from the user's first message to the assistant's last message. Tell what the user asked, what the assistant did, and the result. Write 3 to 6 sentences. Start with "STE:" and write nothing else.`

// The summary shows as one plain-text line: newlines there become U+FFFD and
// Markdown is drawn raw, so flatten both whatever the model wrote.
export function oneLine(text: string): string {
  return text
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .split(/\s*\n+\s*/)
    .filter(part => part !== '')
    .join(' · ')
    .trim()
}

const isPrompt = (m: SessionMessage) =>
  m.role === 'user' && m.text.trim() !== '' && !m.toolResults?.length

// The latest exchange: from the last prompt the person typed to the end.
export function latestExchange(messages: readonly SessionMessage[]): string {
  const start = messages.findLastIndex(isPrompt)
  if (start < 0) return ''

  const lines = messages
    .slice(start)
    .filter(m => m.text.trim() !== '')
    .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${m.text.trim()}`)
  const text = lines.join('\n\n')

  return text.length > MAX_CHARS
    ? `${text.slice(0, MAX_CHARS / 2)}\n[...]\n${text.slice(-MAX_CHARS / 2)}`
    : text
}

async function summarize($: EngineInterface, model: string): Promise<string | undefined> {
  const exchange = latestExchange(await $.session.messages())
  if (exchange === '') return undefined

  const r = await $.model.complete({
    model,
    system: RULES,
    prompt: exchange,
    effort: 'low',
    maxTokens: 800,
    timeoutMs: 30_000,
  })
  if (!r.isAnswered) {
    $.ui.log(`ste-summary: no summary (${r.reason})`)
    return undefined
  }

  return oneLine(r.text)
}

async function isEnabled($: EngineInterface): Promise<boolean> {
  return (await $.store.get(ENABLED)) !== false
}

export const register: Register = (on, options) => {
  const model = String(options.model ?? 'sonnet')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ste',
      description: 'STE summaries: on, off, or now',
    })

    return next(e)
  })

  on('command.run', { command: 'ste' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await $.store.set(ENABLED, arg === 'on')
      return { text: `STE summaries are ${arg}.` }
    }
    if (arg === 'now') {
      return { text: (await summarize($, model)) ?? 'No exchange to summarize.' }
    }

    return {
      text: `STE summaries are ${(await isEnabled($)) ? 'on' : 'off'}. Use /ste on, /ste off or /ste now.`,
    }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || e.answer.trim() === '') {
      return done
    }
    if (!(await isEnabled($))) return done

    // A text other than the answer is shown beneath it; the record stays.
    const summary = await summarize($, model)

    return summary === undefined ? done : { ...done, text: summary }
  })
}
