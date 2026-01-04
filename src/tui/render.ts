// TUI rendering logic
// Handles updating the display with agent outputs and system status

import { LayoutElements } from './layout.js';
import { AppState, toRoman } from '../state.js';

/**
 * Box drawing characters for borders
 */
const BOX_CHARS = {
  topLeft: '\u2554',     // ╔
  topRight: '\u2557',    // ╗
  bottomLeft: '\u255A',  // ╚
  bottomRight: '\u255D', // ╝
  horizontal: '\u2550',  // ═
  vertical: '\u2551',    // ║
  leftT: '\u2560',       // ╠
  rightT: '\u2563',      // ╣
};

/**
 * Progress bar characters
 */
const PROGRESS_CHARS = {
  filled: '\u2588',  // █
  empty: '\u2591',   // ░
};

/**
 * Tool indicator character
 */
const TOOL_INDICATOR = '\u25C8'; // ◈

/**
 * Animation state for loading dots
 */
let animationFrame = 0;

/**
 * Generates animated dots text based on current animation frame
 * Cycles through: "Working." -> "Working.." -> "Working..."
 * @param baseText - The base text to animate (e.g., "Working" or "Waiting for Arbiter")
 * @returns The text with animated dots appended
 */
export function getAnimatedDots(baseText: string): string {
  const dotCount = (animationFrame % 3) + 1;
  return baseText + '.'.repeat(dotCount);
}

/**
 * Advances the animation frame for the loading dots
 * Should be called by an interval timer
 */
export function advanceAnimation(): void {
  animationFrame = (animationFrame + 1) % 3;
}

/**
 * Resets the animation frame to 0
 */
export function resetAnimation(): void {
  animationFrame = 0;
}

/**
 * Renders the conversation log to the conversation box
 * Formats messages with speakers (You:, Arbiter:, Orchestrator I:, etc.)
 */
export function renderConversation(elements: LayoutElements, state: AppState): void {
  const { conversationBox, screen } = elements;
  const lines: string[] = [];

  // Get effective width for text wrapping
  const effectiveWidth = Math.max((screen.width as number) - 6, 74);

  for (const message of state.conversationLog) {
    // Format speaker label
    const speakerLabel = formatSpeakerLabel(message.speaker);

    // Format and wrap the message text
    const wrappedText = wrapText(message.text, effectiveWidth - speakerLabel.length - 2);
    const textLines = wrappedText.split('\n');

    // First line with speaker label
    lines.push(`  ${speakerLabel} ${textLines[0]}`);

    // Subsequent lines indented to align with first line
    const indent = ' '.repeat(speakerLabel.length + 3);
    for (let i = 1; i < textLines.length; i++) {
      lines.push(`${indent}${textLines[i]}`);
    }

    // Add empty line between messages
    lines.push('');
  }

  // Join lines and add vertical borders
  const formattedContent = lines
    .map(line => {
      const paddedLine = line.padEnd(effectiveWidth, ' ');
      return `${BOX_CHARS.vertical}${paddedLine}${BOX_CHARS.vertical}`;
    })
    .join('\n');

  conversationBox.setContent(formattedContent);

  // Auto-scroll to bottom
  conversationBox.setScrollPerc(100);

  screen.render();
}

/**
 * Waiting state enum for different waiting scenarios
 */
export type WaitingState = 'none' | 'arbiter' | 'orchestrator';

/**
 * Renders the status bar with context percentages and current tool
 *
 * When orchestrator is active:
 * ║  Arbiter ─────────────────────────────────────────────────── ██░░░░░░░░ 18%    ║
 * ║  Orchestrator I ──────────────────────────────────────────── ████████░░ 74%    ║
 * ║  ◈ Edit (12)                                                                   ║
 *
 * When no orchestrator (Arbiter speaks to human):
 * ║  Arbiter ─────────────────────────────────────────────────── ██░░░░░░░░ 18%    ║
 * ║  Awaiting your command.                                                        ║
 *
 * @param waitingState - Optional waiting state to show animated dots
 */
export function renderStatus(elements: LayoutElements, state: AppState, waitingState: WaitingState = 'none'): void {
  const { statusBox, screen } = elements;
  const effectiveWidth = Math.max((screen.width as number) - 2, 78);

  // Status separator at top
  const separator = BOX_CHARS.leftT + BOX_CHARS.horizontal.repeat(effectiveWidth) + BOX_CHARS.rightT;

  // Progress bar width (10 characters for the bar)
  const barWidth = 10;

  // Build Arbiter status line
  const arbiterLabel = 'Arbiter';
  const arbiterBar = renderProgressBar(state.arbiterContextPercent, barWidth);
  const arbiterPercent = `${Math.round(state.arbiterContextPercent)}%`.padStart(4);
  const arbiterDashes = createDashLine(
    effectiveWidth - arbiterLabel.length - barWidth - arbiterPercent.length - 8
  );
  const arbiterLine = `${BOX_CHARS.vertical}  ${arbiterLabel} ${arbiterDashes} ${arbiterBar} ${arbiterPercent}  ${BOX_CHARS.vertical}`;

  let orchestratorLine: string;
  let toolLine: string;

  if (state.currentOrchestrator) {
    // Orchestrator status line
    const orchLabel = `Orchestrator ${toRoman(state.currentOrchestrator.number)}`;
    const orchBar = renderProgressBar(state.currentOrchestrator.contextPercent, barWidth);
    const orchPercent = `${Math.round(state.currentOrchestrator.contextPercent)}%`.padStart(4);
    const orchDashes = createDashLine(
      effectiveWidth - orchLabel.length - barWidth - orchPercent.length - 8
    );
    orchestratorLine = `${BOX_CHARS.vertical}  ${orchLabel} ${orchDashes} ${orchBar} ${orchPercent}  ${BOX_CHARS.vertical}`;

    // Tool indicator line
    if (state.currentOrchestrator.currentTool) {
      const toolText = `${TOOL_INDICATOR} ${state.currentOrchestrator.currentTool} (${state.currentOrchestrator.toolCallCount})`;
      const toolPadding = ' '.repeat(effectiveWidth - toolText.length - 2);
      toolLine = `${BOX_CHARS.vertical}  ${toolText}${toolPadding}${BOX_CHARS.vertical}`;
    } else if (waitingState === 'orchestrator') {
      // Show animated dots when waiting for orchestrator response
      const waitingText = getAnimatedDots('Working');
      const waitingPadding = ' '.repeat(effectiveWidth - waitingText.length - 2);
      toolLine = `${BOX_CHARS.vertical}  ${waitingText}${waitingPadding}${BOX_CHARS.vertical}`;
    } else {
      const waitingText = 'Working...';
      const waitingPadding = ' '.repeat(effectiveWidth - waitingText.length - 2);
      toolLine = `${BOX_CHARS.vertical}  ${waitingText}${waitingPadding}${BOX_CHARS.vertical}`;
    }
  } else if (waitingState === 'arbiter') {
    // Waiting for Arbiter response - show animated dots
    const waitingText = getAnimatedDots('Waiting for Arbiter');
    const waitingPadding = ' '.repeat(effectiveWidth - waitingText.length - 2);
    orchestratorLine = `${BOX_CHARS.vertical}  ${waitingText}${waitingPadding}${BOX_CHARS.vertical}`;
    toolLine = `${BOX_CHARS.vertical}${' '.repeat(effectiveWidth)}${BOX_CHARS.vertical}`;
  } else {
    // No orchestrator - show awaiting message
    const awaitingText = 'Awaiting your command.';
    const awaitingPadding = ' '.repeat(effectiveWidth - awaitingText.length - 2);
    orchestratorLine = `${BOX_CHARS.vertical}  ${awaitingText}${awaitingPadding}${BOX_CHARS.vertical}`;
    toolLine = `${BOX_CHARS.vertical}${' '.repeat(effectiveWidth)}${BOX_CHARS.vertical}`;
  }

  statusBox.setContent(`${separator}\n${arbiterLine}\n${orchestratorLine}\n${toolLine}`);
  screen.render();
}

/**
 * Creates an ASCII progress bar
 * @param percent - Current percentage (0-100)
 * @param width - Total width of the progress bar
 * @returns Progress bar string like "████████░░"
 */
export function renderProgressBar(percent: number, width: number): string {
  // Clamp percent between 0 and 100
  const clampedPercent = Math.max(0, Math.min(100, percent));

  // Calculate filled width
  const filledWidth = Math.round((clampedPercent / 100) * width);
  const emptyWidth = width - filledWidth;

  // Build progress bar
  return PROGRESS_CHARS.filled.repeat(filledWidth) + PROGRESS_CHARS.empty.repeat(emptyWidth);
}

/**
 * Formats a speaker label with appropriate styling
 */
function formatSpeakerLabel(speaker: string): string {
  switch (speaker) {
    case 'human':
      return '{bold}You:{/bold}';
    case 'arbiter':
      return '{bold}{yellow-fg}Arbiter:{/yellow-fg}{/bold}';
    default:
      // Orchestrator labels come through as-is (e.g., "Orchestrator I")
      if (speaker.startsWith('Orchestrator')) {
        return `{bold}{cyan-fg}${speaker}:{/cyan-fg}{/bold}`;
      }
      return `{bold}${speaker}:{/bold}`;
  }
}

/**
 * Wraps text to fit within a specified width
 */
function wrapText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return text;
  }

  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    // Handle words that are longer than maxWidth
    if (word.length > maxWidth) {
      // If there's content in the current line, push it first
      if (currentLine) {
        lines.push(currentLine.trim());
        currentLine = '';
      }
      // Break the long word
      let remaining = word;
      while (remaining.length > maxWidth) {
        lines.push(remaining.substring(0, maxWidth));
        remaining = remaining.substring(maxWidth);
      }
      currentLine = remaining + ' ';
      continue;
    }

    // Check if adding this word would exceed the limit
    if (currentLine.length + word.length + 1 > maxWidth) {
      lines.push(currentLine.trim());
      currentLine = word + ' ';
    } else {
      currentLine += word + ' ';
    }
  }

  // Add remaining content
  if (currentLine.trim()) {
    lines.push(currentLine.trim());
  }

  return lines.join('\n');
}

/**
 * Creates a dash line for status bar alignment
 * Uses em-dash (─) for cleaner appearance
 */
function createDashLine(length: number): string {
  const dashChar = '\u2500'; // ─
  return dashChar.repeat(Math.max(0, length));
}

/**
 * Renders the input area with prompt
 */
export function renderInputArea(elements: LayoutElements): void {
  const { screen } = elements;
  const effectiveWidth = Math.max((screen.width as number) - 2, 78);

  // Input separator and prompt are handled by the layout
  // This function can be used for additional input area styling if needed

  // Create input separator
  const inputSeparator = BOX_CHARS.leftT + BOX_CHARS.horizontal.repeat(effectiveWidth) + BOX_CHARS.rightT;

  // The inputBox already has its own styling from layout
  // We can prepend a separator to the status box if needed
  screen.render();
}

/**
 * Updates the entire display
 */
export function renderAll(elements: LayoutElements, state: AppState): void {
  renderConversation(elements, state);
  renderStatus(elements, state);
  elements.screen.render();
}
