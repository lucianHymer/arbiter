/**
 * Shared types for the TUI components
 */

/**
 * Speaker types for chat messages
 */
export type Speaker = 'human' | 'arbiter' | 'orchestrator';

/**
 * Chat message interface
 */
export interface Message {
  /** Unique identifier for the message */
  id: string;
  /** Who sent the message */
  speaker: Speaker;
  /** Orchestrator number for orchestrator messages (e.g., 1 for "Conjuring I") */
  orchestratorNumber?: number;
  /** The message text content */
  text: string;
  /** When the message was created */
  timestamp: Date;
}

/**
 * Waiting state for animations
 */
export type WaitingState = 'none' | 'arbiter' | 'orchestrator';

/**
 * Scroll hook return type
 */
export interface ScrollState {
  /** Current scroll offset (lines from top) */
  offset: number;
  /** Function to scroll by a number of lines (positive = down, negative = up) */
  scrollBy: (lines: number) => void;
  /** Maximum scroll offset */
  maxScroll: number;
  /** Whether scrolled to the bottom */
  isAtBottom: boolean;
  /** Scroll to bottom */
  scrollToBottom: () => void;
}
