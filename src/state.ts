// Global state management for the Arbiter system
// Tracks agent states, conversation history, and system configuration

/**
 * Message type for conversation log entries
 */
export interface Message {
  speaker: 'human' | 'arbiter' | string; // string allows for orchestrator tags like "Orchestrator I"
  text: string;
  timestamp: Date;
}

/**
 * Current orchestrator state
 */
export interface OrchestratorState {
  id: string;
  sessionId: string;
  number: number; // I, II, III...
  contextPercent: number;
  currentTool: string | null; // e.g., "Edit"
  toolCallCount: number;
}

/**
 * Arbiter intent - explicit routing decision from structured output
 * Replaces the old mode-based routing
 */
export type ArbiterIntent =
  | 'address_human'
  | 'address_orchestrator'
  | 'summon_orchestrator'
  | 'release_orchestrators'
  | 'musings';

/**
 * Main application state interface
 */
export interface AppState {
  arbiterSessionId: string | null;
  arbiterContextPercent: number;
  currentOrchestrator: OrchestratorState | null;
  conversationLog: Message[];
  requirementsPath: string | null;
}

/**
 * Creates the initial application state
 */
export function createInitialState(): AppState {
  return {
    arbiterSessionId: null,
    arbiterContextPercent: 0,
    currentOrchestrator: null,
    conversationLog: [],
    requirementsPath: null,
  };
}

/**
 * Updates the Arbiter's context percentage
 */
export function updateArbiterContext(state: AppState, percent: number): void {
  state.arbiterContextPercent = percent;
}

/**
 * Updates the current Orchestrator's context percentage
 */
export function updateOrchestratorContext(state: AppState, percent: number): void {
  if (state.currentOrchestrator) {
    state.currentOrchestrator.contextPercent = percent;
  }
}

/**
 * Sets the current orchestrator
 */
export function setCurrentOrchestrator(
  state: AppState,
  orch: { id: string; sessionId: string; number: number },
): void {
  state.currentOrchestrator = {
    id: orch.id,
    sessionId: orch.sessionId,
    number: orch.number,
    contextPercent: 0,
    currentTool: null,
    toolCallCount: 0,
  };
}

/**
 * Clears the current orchestrator (sets to null)
 */
export function clearCurrentOrchestrator(state: AppState): void {
  state.currentOrchestrator = null;
}

/**
 * Adds a message to the conversation log
 */
export function addMessage(state: AppState, speaker: string, text: string): void {
  state.conversationLog.push({
    speaker,
    text,
    timestamp: new Date(),
  });
}

/**
 * Updates the current orchestrator's tool info
 */
export function updateOrchestratorTool(state: AppState, tool: string | null, count: number): void {
  if (state.currentOrchestrator) {
    state.currentOrchestrator.currentTool = tool;
    state.currentOrchestrator.toolCallCount = count;
  }
}

/**
 * Converts a number to Roman numerals
 * Supports numbers 1-3999
 */
export function toRoman(num: number): string {
  if (num < 1 || num > 3999) {
    throw new Error('Number must be between 1 and 3999');
  }

  const romanNumerals: [number, string][] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];

  let result = '';
  let remaining = num;

  for (const [value, symbol] of romanNumerals) {
    while (remaining >= value) {
      result += symbol;
      remaining -= value;
    }
  }

  return result;
}
