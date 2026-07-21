export interface StoryRevisionCommand {
  beforeRevisionId: string
  afterRevisionId: string
  label: string
  selectionBefore: string | null
  selectionAfter: string | null
}

export interface StoryRevisionHistoryState {
  headRevisionId: string | null
  undo: StoryRevisionCommand[]
  redo: StoryRevisionCommand[]
  pending: 'undo' | 'redo' | null
}

export type StoryRevisionHistoryAction =
  | { type: 'reset'; headRevisionId: string | null }
  | { type: 'authority-refreshed'; headRevisionId: string | null }
  | {
      type: 'record-commit'
      beforeRevisionId: string
      afterRevisionId: string
      label: string
      selectionBefore?: string | null
      selectionAfter?: string | null
    }
  | { type: 'begin-navigation'; direction: 'undo' | 'redo' }
  | { type: 'complete-navigation'; direction: 'undo' | 'redo'; headRevisionId: string }
  | { type: 'abort-navigation' }

const MAX_SESSION_COMMANDS = 100

export function createStoryRevisionHistoryState(
  headRevisionId: string | null = null,
): StoryRevisionHistoryState {
  return {
    headRevisionId,
    undo: [],
    redo: [],
    pending: null,
  }
}

function boundedCommands(commands: StoryRevisionCommand[]): StoryRevisionCommand[] {
  return commands.length > MAX_SESSION_COMMANDS
    ? commands.slice(commands.length - MAX_SESSION_COMMANDS)
    : commands
}

/**
 * This reducer stores only immutable revision pointers and interaction labels.
 * It never stores or applies a Story snapshot: undo/redo becomes authoritative
 * only after the server restores the selected revision as a brand-new head.
 */
export function storyRevisionHistoryReducer(
  state: StoryRevisionHistoryState,
  action: StoryRevisionHistoryAction,
): StoryRevisionHistoryState {
  switch (action.type) {
    case 'reset':
      return createStoryRevisionHistoryState(action.headRevisionId)
    case 'authority-refreshed':
      return action.headRevisionId === state.headRevisionId
        ? { ...state, pending: null }
        : createStoryRevisionHistoryState(action.headRevisionId)
    case 'record-commit': {
      if (action.beforeRevisionId === action.afterRevisionId) {
        return { ...state, headRevisionId: action.afterRevisionId, pending: null }
      }
      const command: StoryRevisionCommand = {
        beforeRevisionId: action.beforeRevisionId,
        afterRevisionId: action.afterRevisionId,
        label: action.label.trim() || '编辑剧本',
        selectionBefore: action.selectionBefore ?? null,
        selectionAfter: action.selectionAfter ?? null,
      }
      // A commit based on an unrecognised head came from outside this local
      // command chain. Keep the new command, but do not offer unsafe traversal
      // through history whose exact base can no longer be proven.
      const priorUndo = state.headRevisionId === null || state.headRevisionId === action.beforeRevisionId
        ? state.undo
        : []
      return {
        headRevisionId: action.afterRevisionId,
        undo: boundedCommands([...priorUndo, command]),
        redo: [],
        pending: null,
      }
    }
    case 'begin-navigation':
      if (state.pending !== null) return state
      if (action.direction === 'undo' ? state.undo.length === 0 : state.redo.length === 0) return state
      return { ...state, pending: action.direction }
    case 'complete-navigation': {
      if (state.pending !== action.direction) return state
      if (action.direction === 'undo') {
        const command = state.undo.at(-1)
        if (!command) return { ...state, pending: null }
        return {
          headRevisionId: action.headRevisionId,
          undo: state.undo.slice(0, -1),
          redo: boundedCommands([...state.redo, command]),
          pending: null,
        }
      }
      const command = state.redo.at(-1)
      if (!command) return { ...state, pending: null }
      return {
        headRevisionId: action.headRevisionId,
        undo: boundedCommands([...state.undo, command]),
        redo: state.redo.slice(0, -1),
        pending: null,
      }
    }
    case 'abort-navigation':
      return state.pending === null ? state : { ...state, pending: null }
  }
}

export function storyRevisionNavigationCommand(
  state: StoryRevisionHistoryState,
  direction: 'undo' | 'redo',
): StoryRevisionCommand | null {
  return (direction === 'undo' ? state.undo.at(-1) : state.redo.at(-1)) ?? null
}

export function storyRevisionNavigationTarget(
  command: StoryRevisionCommand,
  direction: 'undo' | 'redo',
): string {
  return direction === 'undo' ? command.beforeRevisionId : command.afterRevisionId
}
