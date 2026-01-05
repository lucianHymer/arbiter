// TUI rendering logic - RPG-style scene rendering
// Renders the wizard's circle with Arbiter, campfire, and orchestrator wizards

import { LayoutElements } from './layout.js';
import { AppState, toRoman } from '../state.js';
import {
  ARBITER_SPRITE,
  HUMAN_SPRITE,
  createWizardSprite,
  getSpriteWidth,
} from './sprites.js';
import {
  getCampfireFrame,
  getAnimatedDots,
  getWizardGemFrame,
  advanceAnimation as advanceAnimationInternal,
  resetAnimation as resetAnimationInternal,
  setAnimationActive,
} from './animations.js';
import {
  createSpeechBubble,
  addTailLeft,
  addTailRight,
  getBubbleWidth,
  getBubbleHeight,
  stripColorTags,
} from './speech-bubble.js';

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
 * Waiting state enum for different waiting scenarios
 */
export type WaitingState = 'none' | 'arbiter' | 'orchestrator';

/**
 * Re-export animation functions for backward compatibility
 */
export function advanceAnimation(): void {
  advanceAnimationInternal();
}

export function resetAnimation(): void {
  resetAnimationInternal();
}

/**
 * Creates an ASCII progress bar with color based on percentage
 * @param percent - Current percentage (0-100)
 * @param width - Total width of the progress bar
 * @returns Progress bar string with color tags
 */
export function renderProgressBar(percent: number, width: number): string {
  // Clamp percent between 0 and 100
  const clampedPercent = Math.max(0, Math.min(100, percent));

  // Calculate filled width
  const filledWidth = Math.round((clampedPercent / 100) * width);
  const emptyWidth = width - filledWidth;

  // Determine color based on percentage
  let color: string;
  if (clampedPercent < 50) {
    color = 'green';
  } else if (clampedPercent < 80) {
    color = 'yellow';
  } else {
    color = 'red';
  }

  // Build progress bar with color
  const filled = PROGRESS_CHARS.filled.repeat(filledWidth);
  const empty = PROGRESS_CHARS.empty.repeat(emptyWidth);

  return `{${color}-fg}${filled}{/${color}-fg}${empty}`;
}

/**
 * Pad a line to a specific width, accounting for color tags
 * @param line - The line (may contain color tags)
 * @param width - Target width
 * @returns Padded line
 */
function padLineToWidth(line: string, width: number): string {
  const visibleLength = stripColorTags(line).length;
  if (visibleLength >= width) {
    return line;
  }
  return line + ' '.repeat(width - visibleLength);
}

/**
 * Truncate a line to fit within a width, accounting for color tags
 * This is a simplified truncation that preserves color tags
 * @param line - The line (may contain color tags)
 * @param maxWidth - Maximum visible width
 * @returns Truncated line
 */
function truncateLineToWidth(line: string, maxWidth: number): string {
  const visibleLength = stripColorTags(line).length;
  if (visibleLength <= maxWidth) {
    return line;
  }
  // Simple truncation - just return what fits
  // Note: This may break color tags, but it prevents overflow
  let visible = 0;
  let result = '';
  let inTag = false;

  for (const char of line) {
    if (char === '{') {
      inTag = true;
      result += char;
    } else if (char === '}') {
      inTag = false;
      result += char;
    } else if (inTag) {
      result += char;
    } else {
      if (visible < maxWidth) {
        result += char;
        visible++;
      }
    }
  }

  return result;
}

/**
 * Render a sprite centered vertically in a zone
 * @param sprite - The sprite content
 * @param zoneWidth - Width of the zone
 * @param zoneHeight - Height of the zone
 * @param horizontalOffset - Optional horizontal offset within zone (default 0)
 * @returns Array of lines for this zone
 */
function renderSpriteInZone(
  sprite: string,
  zoneWidth: number,
  zoneHeight: number,
  horizontalOffset: number = 0
): string[] {
  const lines: string[] = [];
  const spriteLines = sprite.split('\n');
  const spriteHeight = spriteLines.length;

  // Center vertically
  const startY = Math.floor((zoneHeight - spriteHeight) / 2);

  for (let y = 0; y < zoneHeight; y++) {
    const spriteLineIndex = y - startY;
    if (spriteLineIndex >= 0 && spriteLineIndex < spriteLines.length) {
      // Add horizontal offset and the sprite line
      const spriteLine = spriteLines[spriteLineIndex];
      const paddedLine = ' '.repeat(horizontalOffset) + spriteLine;
      lines.push(truncateLineToWidth(paddedLine, zoneWidth));
    } else {
      lines.push('');
    }
  }

  return lines;
}

/**
 * Merge two zone line arrays, overlaying non-empty content
 * @param base - Base lines array
 * @param overlay - Lines to overlay on top
 * @param zoneWidth - Width of the zone
 * @returns Merged lines
 */
function mergeZoneLines(base: string[], overlay: string[], zoneWidth: number): string[] {
  const result: string[] = [];
  const maxLen = Math.max(base.length, overlay.length);

  for (let i = 0; i < maxLen; i++) {
    const baseLine = base[i] || '';
    const overlayLine = overlay[i] || '';

    // If overlay has content, use it; otherwise use base
    if (stripColorTags(overlayLine).trim()) {
      result.push(overlayLine);
    } else {
      result.push(baseLine);
    }
  }

  return result;
}

/**
 * Render the left zone: Human sprite + speech bubble (when human is speaking)
 */
function renderLeftZone(
  state: AppState,
  zoneWidth: number,
  zoneHeight: number
): string[] {
  const lines: string[] = new Array(zoneHeight).fill('');

  const lastMessage = state.conversationLog[state.conversationLog.length - 1];

  // Show human sprite when human spoke last
  if (lastMessage && lastMessage.speaker === 'human') {
    // Render human sprite on the left side of zone
    const humanLines = renderSpriteInZone(HUMAN_SPRITE, zoneWidth, zoneHeight, 2);

    // Create speech bubble
    const maxBubbleWidth = Math.min(zoneWidth - 10, 30);
    let bubble = createSpeechBubble(lastMessage.text, maxBubbleWidth, 'human');
    bubble = addTailRight(bubble);

    // Render bubble to the right of human
    const bubbleLines = bubble.split('\n');
    const bubbleStartY = Math.floor((zoneHeight - bubbleLines.length) / 2);
    const humanWidth = getSpriteWidth(HUMAN_SPRITE);
    const bubbleOffset = humanWidth + 4;

    // Merge human and bubble
    for (let y = 0; y < zoneHeight; y++) {
      const humanPart = humanLines[y] || '';
      const bubbleIndex = y - bubbleStartY;

      if (bubbleIndex >= 0 && bubbleIndex < bubbleLines.length) {
        // Combine human sprite and bubble on same line
        const humanVisible = stripColorTags(humanPart).length;
        const padding = Math.max(0, bubbleOffset - humanVisible);
        lines[y] = humanPart + ' '.repeat(padding) + bubbleLines[bubbleIndex];
      } else {
        lines[y] = humanPart;
      }
    }
  }

  return lines;
}

/**
 * Render the center zone: Arbiter sprite + campfire below
 */
function renderCenterZone(
  state: AppState,
  zoneWidth: number,
  zoneHeight: number
): string[] {
  const lines: string[] = new Array(zoneHeight).fill('');

  const campfireFrame = getCampfireFrame();
  const campfireLines = campfireFrame.split('\n');
  const arbiterLines = ARBITER_SPRITE.split('\n');

  const arbiterHeight = arbiterLines.length;
  const campfireHeight = campfireLines.length;
  const totalHeight = arbiterHeight + campfireHeight + 1; // +1 for spacing

  // Center the combined arbiter+campfire vertically
  const startY = Math.floor((zoneHeight - totalHeight) / 2);

  // Center horizontally
  const arbiterWidth = getSpriteWidth(ARBITER_SPRITE);
  const campfireWidth = getSpriteWidth(campfireFrame);
  const arbiterOffset = Math.floor((zoneWidth - arbiterWidth) / 2);
  const campfireOffset = Math.floor((zoneWidth - campfireWidth) / 2);

  // Render arbiter
  for (let i = 0; i < arbiterHeight; i++) {
    const y = startY + i;
    if (y >= 0 && y < zoneHeight) {
      lines[y] = ' '.repeat(arbiterOffset) + arbiterLines[i];
    }
  }

  // Render campfire below arbiter
  const campfireStartY = startY + arbiterHeight + 1;
  for (let i = 0; i < campfireHeight; i++) {
    const y = campfireStartY + i;
    if (y >= 0 && y < zoneHeight) {
      lines[y] = ' '.repeat(campfireOffset) + campfireLines[i];
    }
  }

  // If arbiter is speaking, add speech bubble
  const lastMessage = state.conversationLog[state.conversationLog.length - 1];
  if (lastMessage && lastMessage.speaker === 'arbiter') {
    const maxBubbleWidth = Math.min(zoneWidth - 4, 35);
    let bubble = createSpeechBubble(lastMessage.text, maxBubbleWidth, 'arbiter');
    // Tail points toward who arbiter is talking to
    if (state.mode === 'human_to_arbiter') {
      bubble = addTailLeft(bubble); // Talking to human (left)
    } else {
      bubble = addTailRight(bubble); // Talking to wizard (right)
    }

    const bubbleLines = bubble.split('\n');
    const bubbleHeight = bubbleLines.length;
    const bubbleStartY = Math.max(0, startY - bubbleHeight - 1);
    const bubbleOffset = Math.floor((zoneWidth - getBubbleWidth(bubble)) / 2);

    for (let i = 0; i < bubbleHeight; i++) {
      const y = bubbleStartY + i;
      if (y >= 0 && y < zoneHeight) {
        lines[y] = ' '.repeat(Math.max(0, bubbleOffset)) + bubbleLines[i];
      }
    }
  }

  return lines;
}

/**
 * Render the right zone: Wizard sprite (when orchestrator is active)
 */
function renderRightZone(
  state: AppState,
  zoneWidth: number,
  zoneHeight: number
): string[] {
  const lines: string[] = new Array(zoneHeight).fill('');

  if (!state.currentOrchestrator) {
    return lines;
  }

  // Create wizard sprite
  const romanNumeral = toRoman(state.currentOrchestrator.number);
  const gemFrame = getWizardGemFrame();
  const wizardSprite = createWizardSprite(romanNumeral, true, gemFrame);
  const wizardLines = wizardSprite.split('\n');
  const wizardHeight = wizardLines.length;
  const wizardWidth = getSpriteWidth(wizardSprite);

  // Center wizard vertically
  const wizardStartY = Math.floor((zoneHeight - wizardHeight) / 2);

  // Position wizard on the left side of the right zone (closer to center/campfire)
  const wizardOffset = 2;

  // Render wizard
  for (let i = 0; i < wizardHeight; i++) {
    const y = wizardStartY + i;
    if (y >= 0 && y < zoneHeight) {
      lines[y] = ' '.repeat(wizardOffset) + wizardLines[i];
    }
  }

  // If orchestrator is speaking, add speech bubble
  const lastMessage = state.conversationLog[state.conversationLog.length - 1];
  if (lastMessage && lastMessage.speaker === 'orchestrator') {
    const maxBubbleWidth = Math.min(zoneWidth - wizardWidth - 8, 30);
    let bubble = createSpeechBubble(lastMessage.text, maxBubbleWidth, 'orchestrator');
    bubble = addTailLeft(bubble); // Points left toward wizard

    const bubbleLines = bubble.split('\n');
    const bubbleHeight = bubbleLines.length;
    const bubbleStartY = Math.floor((zoneHeight - bubbleHeight) / 2);
    const bubbleOffset = wizardOffset + wizardWidth + 2;

    // Merge wizard and bubble
    for (let i = 0; i < bubbleHeight; i++) {
      const y = bubbleStartY + i;
      if (y >= 0 && y < zoneHeight && lines[y]) {
        const existingLine = lines[y];
        const existingVisible = stripColorTags(existingLine).length;
        const padding = Math.max(0, bubbleOffset - existingVisible);
        lines[y] = existingLine + ' '.repeat(padding) + bubbleLines[i];
      }
    }
  }

  return lines;
}

/**
 * Renders the RPG-style scene (DEPRECATED - now using AIM-style chat log)
 * Kept for backward compatibility but does nothing since chatLog handles messages
 */
export function renderScene(elements: LayoutElements, state: AppState): void {
  // No-op: Chat messages now go directly to chatLog via chatLog.log()
  elements.screen.render();
}

/**
 * Renders the conversation log (DEPRECATED - now using AIM-style chat log)
 */
export function renderConversation(elements: LayoutElements, state: AppState): void {
  renderScene(elements, state);
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
 * Renders the status bar with context percentages and current tool
 * RPG-style status showing Arbiter and Wizard stats
 *
 * Line 1: Arbiter context % and progress bar
 * Line 2: Orchestrator context % (if active) or waiting message
 * Line 3: Tool indicator + "[Tab] Logbook" hint
 *
 * @param waitingState - Optional waiting state to show animated dots
 */
export function renderStatus(
  elements: LayoutElements,
  state: AppState,
  waitingState: WaitingState = 'none'
): void {
  const { statusBox, screen } = elements;
  const effectiveWidth = Math.max((screen.width as number) - 2, 78);

  // Status separator at top
  const separator = BOX_CHARS.leftT + BOX_CHARS.horizontal.repeat(effectiveWidth) + BOX_CHARS.rightT;

  // Progress bar width (10 characters for the bar)
  const barWidth = 10;

  // Build Arbiter status line
  const arbiterLabel = '{yellow-fg}Arbiter{/yellow-fg}';
  const arbiterLabelLen = 7; // "Arbiter" without tags
  const arbiterBar = renderProgressBar(state.arbiterContextPercent, barWidth);
  const arbiterPercent = `${Math.round(state.arbiterContextPercent)}%`.padStart(4);
  const arbiterDashes = createDashLine(
    effectiveWidth - arbiterLabelLen - barWidth - arbiterPercent.length - 8
  );
  const arbiterLine = `${BOX_CHARS.vertical}  ${arbiterLabel} ${arbiterDashes} ${arbiterBar} ${arbiterPercent}  ${BOX_CHARS.vertical}`;

  let orchestratorLine: string;
  let toolLine: string;

  // Set animation active state based on waiting state
  setAnimationActive(waitingState !== 'none' || (state.currentOrchestrator?.currentTool !== null));

  if (state.currentOrchestrator) {
    // Orchestrator status line
    const orchNumeral = toRoman(state.currentOrchestrator.number);
    const orchLabel = `{cyan-fg}Wizard ${orchNumeral}{/cyan-fg}`;
    const orchLabelLen = 6 + orchNumeral.length + 1; // "Wizard " + numeral
    const orchBar = renderProgressBar(state.currentOrchestrator.contextPercent, barWidth);
    const orchPercent = `${Math.round(state.currentOrchestrator.contextPercent)}%`.padStart(4);
    const orchDashes = createDashLine(
      effectiveWidth - orchLabelLen - barWidth - orchPercent.length - 8
    );
    orchestratorLine = `${BOX_CHARS.vertical}  ${orchLabel} ${orchDashes} ${orchBar} ${orchPercent}  ${BOX_CHARS.vertical}`;

    // Tool indicator line with logbook hint
    const logbookHint = '{gray-fg}[Ctrl+O] Logbook{/gray-fg}';
    const logbookHintLen = 16; // "[Ctrl+O] Logbook" without tags

    if (state.currentOrchestrator.currentTool) {
      const toolText = `${TOOL_INDICATOR} ${state.currentOrchestrator.currentTool} (${state.currentOrchestrator.toolCallCount})`;
      const toolPadding = ' '.repeat(
        Math.max(0, effectiveWidth - toolText.length - logbookHintLen - 4)
      );
      toolLine = `${BOX_CHARS.vertical}  ${toolText}${toolPadding}${logbookHint}${BOX_CHARS.vertical}`;
    } else if (waitingState === 'orchestrator') {
      // Show animated dots when waiting for orchestrator response
      const dots = getAnimatedDots();
      const waitingText = `The wizard works${dots}`;
      const waitingPadding = ' '.repeat(
        Math.max(0, effectiveWidth - waitingText.length - logbookHintLen - 4)
      );
      toolLine = `${BOX_CHARS.vertical}  ${waitingText}${waitingPadding}${logbookHint}${BOX_CHARS.vertical}`;
    } else {
      const workingText = 'The wizard contemplates...';
      const workingPadding = ' '.repeat(
        Math.max(0, effectiveWidth - workingText.length - logbookHintLen - 4)
      );
      toolLine = `${BOX_CHARS.vertical}  ${workingText}${workingPadding}${logbookHint}${BOX_CHARS.vertical}`;
    }
  } else if (waitingState === 'arbiter') {
    // Waiting for Arbiter response - show animated dots
    const dots = getAnimatedDots();
    const waitingText = `Awaiting the Arbiter${dots}`;
    const waitingPadding = ' '.repeat(effectiveWidth - waitingText.length - 2);
    orchestratorLine = `${BOX_CHARS.vertical}  ${waitingText}${waitingPadding}${BOX_CHARS.vertical}`;

    const logbookHint = '{gray-fg}[Ctrl+O] Logbook{/gray-fg}';
    const hintPadding = ' '.repeat(Math.max(0, effectiveWidth - 16 - 2));
    toolLine = `${BOX_CHARS.vertical}  ${hintPadding}${logbookHint}${BOX_CHARS.vertical}`;
  } else {
    // No orchestrator - show awaiting message
    const awaitingText = 'Awaiting your command, mortal.';
    const awaitingPadding = ' '.repeat(effectiveWidth - awaitingText.length - 2);
    orchestratorLine = `${BOX_CHARS.vertical}  ${awaitingText}${awaitingPadding}${BOX_CHARS.vertical}`;

    const logbookHint = '{gray-fg}[Ctrl+O] Logbook{/gray-fg}';
    const hintPadding = ' '.repeat(Math.max(0, effectiveWidth - 16 - 2));
    toolLine = `${BOX_CHARS.vertical}  ${hintPadding}${logbookHint}${BOX_CHARS.vertical}`;
  }

  statusBox.setContent(`${separator}\n${arbiterLine}\n${orchestratorLine}\n${toolLine}`);
  screen.render();
}

/**
 * Renders the input area with prompt
 */
export function renderInputArea(elements: LayoutElements): void {
  const { screen } = elements;
  // The inputBox already has its own styling from layout
  screen.render();
}

/**
 * Updates the entire display - renders both scene and status
 */
export function renderAll(elements: LayoutElements, state: AppState): void {
  renderScene(elements, state);
  renderStatus(elements, state);
  elements.screen.render();
}
