export type FoldKind = 'msg' | 'ran' | 'task'

export type Step = {
  id: string
  tool: string
  label: string
  args: string
  result?: string
  isError?: boolean
  isHelper: boolean
  at: number
}

export type Say = { text: string; rowId?: string; at: number }

export type GroupStatus = 'ok' | 'blocked' | 'failed'

export type Group = { title: string; status: GroupStatus; note?: string; tools: number[] }

export type Term = { term: string; meaning: string }

export type Summary = {
  outcome: string
  groups: Group[]
  reply: string[]
  terms: Term[]
  model: string
  at: number
  isFallback?: boolean
}

export type Fold = {
  id: string
  kind: FoldKind
  at: number
  you: string
  rowId?: string
  steps: Step[]
  says: Say[]
  isWorking: boolean
  summary?: Summary
}

declare module 'claude-code' {
  interface PluginState {
    'plain-summary': {
      folds: Fold[]
      summarizing: string[]
      opened: string[]
      closed: string[]
      openGroups: string[]
      shownCmds: string[]
    }
  }
}
