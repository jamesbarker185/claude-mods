export type Step = {
  id: string
  turnId: string
  raw: string
  plain?: string
  isHelper: boolean
  at: number
}

export type Summary = {
  turnId: string
  ask: string
  text: string
  at: number
}

export type Turn = { id: string; ask: string; steps: number; at: number }

export type Tab = 'summary' | 'timeline'

declare module 'claude-code' {
  interface PluginState {
    'plain-summary': {
      steps: Step[]
      summaries: Summary[]
      turn: Turn | null
      turns: Turn[]
      isSummarizing: boolean
      shown: number
      tab: Tab
      timelineTurns: number
    }
  }
}
