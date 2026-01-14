/**
 * Terminal-Kit based TUI using Strategy 5 (Minimal Redraws)
 *
 * This replaces the Ink-based TUI with a terminal-kit implementation
 * that uses minimal redraws for flicker-free animation and input handling.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import termKit from 'terminal-kit';
import type { RouterCallbacks } from '../router.js';
import { isMusicEnabled, isSfxEnabled, playSfx, toggleMusic, toggleSfx } from '../sound.js';
import type { AppState } from '../state.js';
import { toRoman } from '../state.js';
import {
  getAllSprites,
  hasActiveAnimations,
  registerSprite,
  startAnimationLoop,
  stopAnimationLoop,
} from './animation-loop.js';
import { createRouterCallbacks } from './callbacks.js';
import { DEBUG_LOG_PATH } from './constants.js';
import { createLogViewer, type LogViewer } from './logViewer.js';
import { createRequirementsOverlay, type RequirementsOverlay } from './requirementsOverlay.js';
import { createScene, renderScene, SCENE_HEIGHT, SCENE_WIDTH } from './scene.js';
import { Sprite } from './sprite.js';
import { exitTerminal } from './terminal-cleanup.js';
import {
  CHAR_HEIGHT,
  compositeTiles,
  extractTile,
  loadTileset,
  RESET,
  renderTile,
  TILE,
  TILE_SIZE,
  type Tileset,
} from './tileset.js';
import type { Message, Speaker, WaitingState } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * TUI interface - main entry point for the terminal UI
 * Matches the interface expected by the Router
 */
export interface TUI {
  /** Starts the TUI and takes over the terminal */
  start(): void;
  /** Stops the TUI and restores the terminal */
  stop(): void;
  /** Returns router callbacks for updating the display */
  getRouterCallbacks(): RouterCallbacks;
  /** Registers a callback for user input */
  onInput(callback: (text: string) => void): void;
  /** Registers a callback for when user confirms exit */
  onExit(callback: () => void): void;
  /** Registers a callback for when requirements selection is complete */
  onRequirementsReady(callback: () => void): void;
  /** Start the loading animation for arbiter or orchestrator */
  startWaiting(waitingFor: 'arbiter' | 'orchestrator'): void;
  /** Stop the loading animation */
  stopWaiting(): void;
}

/**
 * Internal state for the TUI
 */
interface TUIState {
  // Tileset
  tileset: Tileset | null;

  // Character selection (used at init time for humanSprite)
  selectedCharacter: number;

  // Chat messages
  messages: Message[];
  scrollOffset: number;

  // Input state
  inputBuffer: string;
  cursorPos: number; // Cursor position (index into inputBuffer)
  mode: 'NORMAL' | 'INSERT';

  // Status info
  arbiterContextPercent: number;
  orchestratorContextPercent: number | null;
  currentTool: string | null;
  toolCallCount: number;
  lastToolTime: number; // timestamp when tool was last set

  // Tool indicator (shown between messages)
  recentTools: string[]; // Last 2 tools used
  toolCountSinceLastMessage: number; // Total tool calls since last chat message
  showToolIndicator: boolean; // Whether to show the tool indicator

  // Animation state
  animationFrame: number;
  blinkCycle: number; // Slower counter for chat blink (increments every animation cycle)
  waitingFor: WaitingState;

  // Exit confirmation state
  pendingExit: boolean;

  // Crash tracking
  crashCount: number;

  // Input lock until arbiter speaks
  arbiterHasSpoken: boolean;

  drawingEnabled: boolean;
}

/**
 * Tracking for minimal redraws (Strategy 5)
 */
interface RedrawTracker {
  lastTileFrame: number;
  lastScrollOffset: number;
  lastInputBuffer: string;
  lastMode: 'NORMAL' | 'INSERT';
  lastMessageCount: number;
  lastContextPercent: number;
  lastOrchestratorPercent: number | null;
  lastChatWaitingFor: WaitingState;
  lastChatAnimFrame: number;
  lastCursorPos: number;
  lastInputHeight: number;
  lastShowToolIndicator: boolean;
  lastToolCount: number;
}

// ============================================================================
// Constants
// ============================================================================

// Scene dimensions (SCENE_WIDTH, SCENE_HEIGHT imported from scene.ts)
const TILE_AREA_WIDTH = SCENE_WIDTH * TILE_SIZE; // 112 chars
const TILE_AREA_HEIGHT = SCENE_HEIGHT * CHAR_HEIGHT; // 48 rows

// Filler tile cache (for grass/trees above and below scene)
const fillerRowCache: Map<string, string[]> = new Map();

// Animation
const ANIMATION_INTERVAL = 250; // ms

// Input area
const MAX_INPUT_LINES = 5; // Maximum visible lines in input area
const SCROLL_PADDING = 10; // Extra rows to scroll past content

// Colors
const COLORS = {
  human: '\x1b[32m', // green
  arbiter: '\x1b[33m', // yellow
  orchestrator: '\x1b[36m', // cyan
  system: '\x1b[2;3m', // dim + italic for narrator/system messages
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

// Terminal-Kit instance
const term = termKit.terminal;

// ============================================================================
// Layout Calculations
// ============================================================================

/**
 * Calculate how many lines the input buffer needs when wrapped
 * @param text The input text (may contain newlines)
 * @param width Available width for text (excluding prompt)
 * @returns Number of lines needed (displayLines capped at MAX_INPUT_LINES, totalLines is actual count)
 */
function calculateInputLines(
  text: string,
  width: number,
): { displayLines: number; totalLines: number } {
  if (!text || width <= 0) return { displayLines: 1, totalLines: 1 };

  // Split by actual newlines first
  const paragraphs = text.split('\n');
  let totalLines = 0;

  for (const para of paragraphs) {
    if (para.length === 0) {
      totalLines += 1; // Empty line
    } else {
      // Calculate wrapped lines for this paragraph
      totalLines += Math.ceil(para.length / width);
    }
  }

  return {
    displayLines: Math.min(Math.max(1, totalLines), MAX_INPUT_LINES),
    totalLines: Math.max(1, totalLines),
  };
}

function getLayout(inputText: string = '', mode: 'INSERT' | 'NORMAL' = 'NORMAL') {
  let width = 180;
  let height = 50;

  if (typeof term.width === 'number' && Number.isFinite(term.width) && term.width > 0) {
    width = term.width;
  }
  if (typeof term.height === 'number' && Number.isFinite(term.height) && term.height > 0) {
    height = term.height;
  }

  // Left side: tile scene - vertically centered
  const tileAreaX = 1;
  const tileAreaY = Math.max(1, Math.floor((height - TILE_AREA_HEIGHT) / 2));
  const fillerRowsAbove = tileAreaY - 1;
  const fillerRowsBelow = Math.max(0, height - (tileAreaY + TILE_AREA_HEIGHT));

  // Right side: chat, status, input
  const chatAreaX = TILE_AREA_WIDTH + 3; // Leave 1 col gap
  const chatAreaWidth = Math.max(40, width - chatAreaX - 1);

  // Calculate dynamic input area height based on content
  const inputTextWidth = chatAreaWidth - 3; // -3 for prompt "> " and cursor space
  const { displayLines: inputLines } = calculateInputLines(inputText, inputTextWidth);

  // Status bar: 1 line in INSERT mode, 2 lines in NORMAL/SCROLL mode
  const statusLines = mode === 'INSERT' ? 1 : 2;

  // Input area at bottom, status bar above it, context bar above that, chat fills remaining space
  const inputY = height - inputLines + 1; // +1 because 1-indexed
  const statusY1 = inputY - statusLines; // First (or only) status line
  const statusY2 = statusLines === 2 ? inputY - 1 : null; // Second line only in NORMAL mode
  const contextY = statusY1 - 1; // Context bar above status
  const chatAreaY = 1;
  const chatAreaHeight = contextY - 1; // Chat goes up to context bar

  return {
    width,
    height,
    tileArea: {
      x: tileAreaX,
      y: tileAreaY,
      width: TILE_AREA_WIDTH,
      height: TILE_AREA_HEIGHT,
      fillerRowsAbove,
      fillerRowsBelow,
    },
    chatArea: {
      x: chatAreaX,
      y: chatAreaY,
      width: chatAreaWidth,
      height: chatAreaHeight,
    },
    contextBar: {
      x: chatAreaX,
      y: contextY,
      width: chatAreaWidth,
    },
    statusBar: {
      x: chatAreaX,
      y: statusY1,
      y2: statusY2,
      width: chatAreaWidth,
      lines: statusLines,
    },
    inputArea: {
      x: chatAreaX,
      y: inputY,
      width: chatAreaWidth,
      height: inputLines,
    },
  };
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a TUI instance using terminal-kit with Strategy 5 (minimal redraws)
 */
export function createTUI(appState: AppState, selectedCharacter?: number): TUI {
  // Internal TUI state
  const state: TUIState = {
    tileset: null,
    selectedCharacter: selectedCharacter ?? TILE.HUMAN_1,
    messages: [],
    scrollOffset: 0,
    inputBuffer: '',
    cursorPos: 0,
    mode: 'INSERT', // Start in insert mode
    arbiterContextPercent: 0,
    orchestratorContextPercent: null,
    currentTool: null,
    toolCallCount: 0,
    lastToolTime: 0,
    recentTools: [],
    toolCountSinceLastMessage: 0,
    showToolIndicator: false,
    animationFrame: 0,
    blinkCycle: 0,
    waitingFor: 'none',
    pendingExit: false,
    crashCount: 0,
    arbiterHasSpoken: false,
    drawingEnabled: true,
  };

  // Tracking for minimal redraws
  const tracker: RedrawTracker = {
    lastTileFrame: -1,
    lastScrollOffset: -1,
    lastInputBuffer: '',
    lastMode: 'INSERT',
    lastMessageCount: -1,
    lastContextPercent: -1,
    lastOrchestratorPercent: null,
    lastChatWaitingFor: 'none',
    lastChatAnimFrame: -1,
    lastCursorPos: -1,
    lastInputHeight: 1,
    lastShowToolIndicator: false,
    lastToolCount: 0,
  };

  // Callbacks
  let inputCallback: ((text: string) => void) | null = null;
  let exitCallback: (() => void) | null = null;
  let requirementsReadyCallback: (() => void) | null = null;
  let animationInterval: NodeJS.Timeout | null = null;
  let isRunning = false;
  let entranceComplete = false; // Track if entrance animation is done
  let pendingArbiterMessage: string | null = null; // Message waiting for entrance to complete

  // Track if we need to show requirements prompt after entrance
  const needsRequirementsPrompt = !appState.requirementsPath;

  // Requirements overlay will be created after sprites are initialized
  let requirementsOverlay: RequirementsOverlay;

  // Log viewer will be created after fullDraw is defined
  let logViewer: LogViewer;

  // Create sprites
  const humanSprite = new Sprite({
    id: 'human',
    tile: state.selectedCharacter,
    position: { row: 2, col: 0 }, // Starts at left edge
    visible: true,
    controlled: false,
  });

  const arbiterSprite = new Sprite({
    id: 'arbiter',
    tile: TILE.ARBITER,
    position: { row: 3, col: 4 }, // Starts by fire
    visible: true,
    controlled: false,
  });

  const scrollSprite = new Sprite({
    id: 'scroll',
    tile: TILE.SCROLL,
    position: { row: 2, col: 2 },
    visible: false,
    controlled: false,
  });

  const spellbookSprite = new Sprite({
    id: 'spellbook',
    tile: TILE.SPELLBOOK,
    position: { row: 4, col: 4 },
    visible: false,
    controlled: false,
  });

  const smokeSprite = new Sprite({
    id: 'smoke',
    tile: TILE.SMOKE,
    position: { row: 1, col: 5 },
    visible: false,
    controlled: false,
  });

  // Create demon sprites (orchestrators)
  const demonConfigs = [
    { row: 2, col: 6, tile: TILE.DEMON_1 },
    { row: 1, col: 6, tile: TILE.DEMON_2 },
    { row: 3, col: 6, tile: TILE.DEMON_3 },
    { row: 4, col: 5, tile: TILE.DEMON_4 },
    { row: 4, col: 3, tile: TILE.DEMON_5 },
    { row: 3, col: 3, tile: TILE.DEMON_6 },
    { row: 0, col: 5, tile: TILE.DEMON_7 },
    { row: 0, col: 4, tile: TILE.DEMON_8 },
    { row: 1, col: 4, tile: TILE.DEMON_9 },
    { row: 2, col: 4, tile: TILE.DEMON_10 },
  ];
  const demons: Sprite[] = demonConfigs.map(
    (cfg, i) =>
      new Sprite({
        id: `demon-${i + 1}`,
        tile: cfg.tile,
        position: { row: cfg.row, col: cfg.col },
        visible: false,
        controlled: false,
      }),
  );

  // Register all sprites with the animation loop
  registerSprite(humanSprite);
  registerSprite(arbiterSprite);
  registerSprite(scrollSprite);
  registerSprite(spellbookSprite);
  registerSprite(smokeSprite);
  for (const d of demons) registerSprite(d);

  // Note: Requirements overlay is initialized after drawing functions are defined
  // (see the "Requirements Overlay (deferred initialization)" section below).

  // Summon sequence state - simplified from state machine
  let isSummoning = false; // Whether a summon sequence is in progress
  let pendingDemons: number[] = []; // Queue of demon indices to spawn

  // Helper to properly suspend the process (used by main TUI and log viewer)
  const suspendProcess = () => {
    // Disable drawing first to prevent any in-flight draws
    state.drawingEnabled = false;
    // Restore terminal to cooked mode
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
    // Remove any SIGTSTP listeners so the default suspend behavior happens
    process.removeAllListeners('SIGTSTP');
    // Send SIGTSTP to process group (0) for proper job control
    process.kill(0, 'SIGTSTP');
  };

  // ============================================================================
  // Drawing Functions (Strategy 5 - Minimal Redraws)
  // ============================================================================

  /**
   * Get or create a cached filler row (grass with occasional trees)
   */
  function getFillerRow(tileset: Tileset, rowIndex: number): string[] {
    const cacheKey = `filler-${rowIndex}`;
    const cached = fillerRowCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const grassPixels = extractTile(tileset, TILE.GRASS);
    const rowLines: string[] = [];

    // Build one row of tiles (SCENE_WIDTH tiles wide)
    for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
      let line = '';
      for (let col = 0; col < SCENE_WIDTH; col++) {
        // Deterministic pattern for variety: mostly grass, some trees
        const pattern = (rowIndex * 7 + col * 13) % 20;
        let tileIndex: number;
        if (pattern < 2) {
          tileIndex = TILE.PINE_TREE;
        } else if (pattern < 4) {
          tileIndex = TILE.BARE_TREE;
        } else if (pattern < 7) {
          tileIndex = TILE.GRASS_SPARSE;
        } else {
          tileIndex = TILE.GRASS;
        }

        // Extract and render tile
        let pixels = extractTile(tileset, tileIndex);
        if (tileIndex >= 80) {
          pixels = compositeTiles(pixels, grassPixels, 1);
        }
        const rendered = renderTile(pixels);
        line += rendered[charRow];
      }
      rowLines.push(line);
    }

    fillerRowCache.set(cacheKey, rowLines);
    return rowLines;
  }

  /**
   * Draw tile scene
   * @param force Force redraw even if animation frame unchanged
   */
  function drawTiles(force: boolean = false) {
    if (!force && state.animationFrame === tracker.lastTileFrame) return;
    tracker.lastTileFrame = state.animationFrame;

    // Skip drawing if log viewer or requirements overlay is open (but state still updates)
    if (logViewer.isOpen() || requirementsOverlay?.isActive()) return;

    if (!state.tileset) return;
    const layout = getLayout(state.inputBuffer, state.mode);

    // Draw filler rows above the scene (build from scene upward, so cut-off is at top edge)
    const rowsAbove = layout.tileArea.fillerRowsAbove;
    if (rowsAbove > 0) {
      const fillerTileRowsAbove = Math.ceil(rowsAbove / CHAR_HEIGHT);
      for (let tileRow = 0; tileRow < fillerTileRowsAbove; tileRow++) {
        const fillerLines = getFillerRow(state.tileset, tileRow);
        // Draw from bottom of this filler tile upward
        for (let charRow = CHAR_HEIGHT - 1; charRow >= 0; charRow--) {
          const screenY =
            layout.tileArea.y - 1 - tileRow * CHAR_HEIGHT - (CHAR_HEIGHT - 1 - charRow);
          if (screenY >= 1) {
            term.moveTo(layout.tileArea.x, screenY);
            process.stdout.write(fillerLines[charRow] + RESET);
          }
        }
      }
    }

    // Get all registered sprites and create scene from them
    const allSprites = getAllSprites();
    const background = createScene(allSprites);

    // Render scene to ANSI string using sprite-based API
    const sceneStr = renderScene(state.tileset, background, allSprites);

    // Split by lines and write each line
    const lines = sceneStr.split('\n');
    for (let i = 0; i < lines.length; i++) {
      term.moveTo(layout.tileArea.x, layout.tileArea.y + i);
      process.stdout.write(lines[i] + RESET);
    }

    // Draw filler rows below the scene (build from scene downward, so cut-off is at bottom edge)
    const rowsBelow = layout.tileArea.fillerRowsBelow;
    if (rowsBelow > 0) {
      const fillerTileRowsBelow = Math.ceil(rowsBelow / CHAR_HEIGHT);
      for (let tileRow = 0; tileRow < fillerTileRowsBelow; tileRow++) {
        const fillerLines = getFillerRow(state.tileset, tileRow + 100); // Offset for different pattern
        for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
          const screenY = layout.tileArea.y + TILE_AREA_HEIGHT + tileRow * CHAR_HEIGHT + charRow;
          if (screenY <= layout.height) {
            term.moveTo(layout.tileArea.x, screenY);
            process.stdout.write(fillerLines[charRow] + RESET);
          }
        }
      }
    }
  }

  /**
   * Build the rendered chat lines array - single source of truth for chat content.
   * Includes messages with spacing, working indicator, and tool indicator.
   * Always reserves space for indicators to prevent layout jumping.
   */
  function getRenderedChatLines(chatWidth: number): { text: string; color: string }[] {
    const renderedLines: { text: string; color: string }[] = [];

    // Messages with spacing between them
    for (let i = 0; i < state.messages.length; i++) {
      const msg = state.messages[i];
      const prefix = getMessagePrefix(msg);
      const color = getMessageColor(msg.speaker);
      const wrappedLines = wrapText(prefix + msg.text, chatWidth);
      for (const line of wrappedLines) {
        renderedLines.push({ text: line, color });
      }
      // Add blank line between messages (but not after the last one)
      if (i < state.messages.length - 1) {
        renderedLines.push({ text: '', color: COLORS.reset });
      }
    }

    // Working indicator line (always visible when waiting, dots animate)
    if (renderedLines.length > 0) {
      renderedLines.push({ text: '', color: COLORS.reset });
    }
    if (state.waitingFor !== 'none') {
      const waiting = state.waitingFor === 'arbiter' ? 'Arbiter' : 'Conjuring';
      // Animate dots: ., .., ..., blank, repeat (cycles every 4 blink cycles)
      const dotPhase = state.blinkCycle % 4;
      const dots = dotPhase < 3 ? '.'.repeat(dotPhase + 1) : '';
      const indicatorColor = state.waitingFor === 'arbiter' ? COLORS.arbiter : COLORS.orchestrator;
      renderedLines.push({
        text: `${waiting} is working${dots}`,
        color: `\x1b[2m${indicatorColor}`,
      });
    } else {
      renderedLines.push({ text: '', color: COLORS.reset });
    }

    // Tool indicator line (directly below working indicator, no extra blank)
    if (state.showToolIndicator && state.recentTools.length > 0) {
      const toolsText = state.recentTools.join(' → ');
      const countText = `(${state.toolCountSinceLastMessage} tool${state.toolCountSinceLastMessage === 1 ? '' : 's'})`;
      const pulse = state.animationFrame < 4 ? '·' : ' ';
      const toolText = `${pulse} ${toolsText} ${countText} ${pulse}`;
      // Use same color as working indicator (yellow for arbiter, cyan for orchestrator)
      const toolColor = state.waitingFor === 'orchestrator' ? COLORS.orchestrator : COLORS.arbiter;
      renderedLines.push({ text: toolText, color: `\x1b[2m${toolColor}` });
    } else {
      renderedLines.push({ text: '', color: COLORS.reset });
    }

    return renderedLines;
  }

  /**
   * Draw chat area - only redraws if messages or scroll changed
   */
  function drawChat(force: boolean = false) {
    // Skip drawing if log viewer or requirements overlay is open
    if (logViewer.isOpen() || requirementsOverlay?.isActive()) return;

    const scrollChanged = state.scrollOffset !== tracker.lastScrollOffset;
    const messagesChanged = state.messages.length !== tracker.lastMessageCount;
    const waitingChanged = state.waitingFor !== tracker.lastChatWaitingFor;
    // Only track blink cycle changes when waiting (for slower blinking effect)
    const blinkChanged =
      state.waitingFor !== 'none' && state.blinkCycle !== tracker.lastChatAnimFrame;
    // Track tool indicator changes
    const toolIndicatorChanged =
      state.showToolIndicator !== tracker.lastShowToolIndicator ||
      state.toolCountSinceLastMessage !== tracker.lastToolCount;

    if (
      !force &&
      !scrollChanged &&
      !messagesChanged &&
      !waitingChanged &&
      !blinkChanged &&
      !toolIndicatorChanged
    )
      return;

    tracker.lastScrollOffset = state.scrollOffset;
    tracker.lastMessageCount = state.messages.length;
    tracker.lastChatWaitingFor = state.waitingFor;
    tracker.lastShowToolIndicator = state.showToolIndicator;
    tracker.lastToolCount = state.toolCountSinceLastMessage;
    tracker.lastChatAnimFrame = state.blinkCycle;

    const layout = getLayout(state.inputBuffer, state.mode);
    const visibleLines = layout.chatArea.height;

    // Get rendered lines from single source of truth
    const renderedLines = getRenderedChatLines(layout.chatArea.width);

    // Calculate max scroll
    const maxScroll = Math.max(0, renderedLines.length - visibleLines + SCROLL_PADDING);
    state.scrollOffset = Math.min(Math.max(0, state.scrollOffset), maxScroll);

    // Draw visible lines
    const chatX = layout.chatArea.x;
    const chatWidth = layout.chatArea.width;

    for (let i = 0; i < visibleLines; i++) {
      const y = layout.chatArea.y + i;
      // Clear the line (only the chat area, not tiles)
      term.moveTo(chatX, y);
      process.stdout.write(' '.repeat(chatWidth));

      const lineIdx = state.scrollOffset + i;
      if (lineIdx < renderedLines.length) {
        const { text, color } = renderedLines[lineIdx];
        term.moveTo(chatX, y);
        process.stdout.write(color + text.substring(0, chatWidth) + COLORS.reset);
      }
    }
  }

  /**
   * Draw context bar - shows Arbiter %, Conjuring %, and tool info
   */
  function drawContext(force: boolean = false) {
    // Skip drawing if log viewer or requirements overlay is open
    if (logViewer.isOpen() || requirementsOverlay?.isActive()) return;

    const contextChanged =
      state.arbiterContextPercent !== tracker.lastContextPercent ||
      state.orchestratorContextPercent !== tracker.lastOrchestratorPercent;

    if (!force && !contextChanged) return;

    // Update trackers
    tracker.lastContextPercent = state.arbiterContextPercent;
    tracker.lastOrchestratorPercent = state.orchestratorContextPercent;

    const layout = getLayout(state.inputBuffer, state.mode);
    const contextX = layout.contextBar.x;
    const contextY = layout.contextBar.y;

    // Clear the context line (only chat area width, not the tile scene)
    term.moveTo(contextX, contextY);
    process.stdout.write(' '.repeat(layout.contextBar.width));

    // Build context info
    let contextInfo = '';

    // Arbiter context
    const arbiterCtx = `Arbiter: ${state.arbiterContextPercent.toFixed(1)}%`;
    contextInfo += `\x1b[33m${arbiterCtx}\x1b[0m`;

    // Orchestrator context
    if (state.orchestratorContextPercent !== null) {
      const orchCtx = `  ·  Conjuring: ${state.orchestratorContextPercent.toFixed(1)}%`;
      contextInfo += `\x1b[36m${orchCtx}\x1b[0m`;
    }

    // Tool info removed - now shown in chat area indicator instead

    // Crash indicator
    if (state.crashCount > 0) {
      contextInfo += `  ·  \x1b[31m⚠ ${state.crashCount} crash${state.crashCount > 1 ? 'es' : ''}\x1b[0m`;
    }

    term.moveTo(contextX, contextY);
    process.stdout.write(contextInfo);
  }

  /**
   * Draw status bar
   * INSERT mode: single line
   * SCROLL mode: two lines with vertical alignment
   */
  function drawStatus(force: boolean = false) {
    // Skip drawing if log viewer or requirements overlay is open
    if (logViewer.isOpen() || requirementsOverlay?.isActive()) return;

    const modeChanged = state.mode !== tracker.lastMode;

    if (!force && !modeChanged) return;

    const layout = getLayout(state.inputBuffer, state.mode);
    const statusX = layout.statusBar.x;
    const statusY1 = layout.statusBar.y;
    const statusY2 = layout.statusBar.y2;

    // Clear status line(s)
    // Clear 3 lines to handle mode transitions:
    // - SCROLL uses 2 lines, INSERT uses 1 line at different positions
    // - When going SCROLL->INSERT, old SCROLL line 1 is above new INSERT line
    term.moveTo(statusX, statusY1 - 1);
    process.stdout.write(' '.repeat(layout.statusBar.width));
    term.moveTo(statusX, statusY1);
    process.stdout.write(' '.repeat(layout.statusBar.width));
    term.moveTo(statusX, statusY1 + 1);
    process.stdout.write(' '.repeat(layout.statusBar.width));

    // Exit confirmation mode - show special prompt
    if (state.pendingExit) {
      const arbiterSid = appState.arbiterSessionId || '(none)';
      const orchSid = appState.currentOrchestrator?.sessionId;
      let exitPrompt = `\x1b[41;97m EXIT? \x1b[0m \x1b[1mPress y to quit, any other key to cancel\x1b[0m`;
      exitPrompt += `  \x1b[2mArbiter: ${arbiterSid}`;
      if (orchSid) {
        exitPrompt += ` | Orch: ${orchSid}`;
      }
      exitPrompt += '\x1b[0m';
      term.moveTo(statusX, statusY1);
      process.stdout.write(exitPrompt);
      return;
    }

    // DIM color for hints
    const DIM = '\x1b[38;2;140;140;140m';
    const RESET = '\x1b[0m';

    // Sound toggle labels: show what pressing the key will DO (toggle to opposite state)
    const musicOn = isMusicEnabled();
    const sfxOn = isSfxEnabled();
    const musicLabel = musicOn ? 'm:music-off' : 'm:music-on';
    const sfxLabel = sfxOn ? 's:sfx-off' : 's:sfx-on';

    if (state.mode === 'INSERT') {
      // Single line: mode + hints + system + sound toggles (no m/s functionality in insert)
      const line =
        '\x1b[42;30m INSERT \x1b[0m' + // Green bg, black text
        `${DIM}    esc:scroll [mode]  ·  \\+enter:newline  ·  ^C:quit  ·  ^Z:suspend${RESET}`;

      term.moveTo(statusX, statusY1);
      process.stdout.write(line);
    } else {
      // Line 1: mode badge + hints starting at col 12 (after " SCROLL " + 4 spaces)
      // i:insert [mode]  ·  ↑/↓:scroll  ·  ^C:quit  ·  ^Z:suspend
      const line1 =
        '\x1b[48;2;130;44;19m\x1b[97m SCROLL \x1b[0m' + // Brown bg, bright white text
        `${DIM}    i:insert [mode]  ·  ↑/↓:scroll  ·  ^C:quit  ·  ^Z:suspend${RESET}`;

      // Line 2: aligned under the hints (12 chars in: 8 for badge + 4 spaces)
      // o:log  ·  m:music-off  ·  s:sfx-off
      const indent = ' '.repeat(12); // 8 (badge) + 4 (spaces)
      const line2 = `${indent}${DIM}o:log  ·  ${musicLabel}  ·  ${sfxLabel}${RESET}`;

      term.moveTo(statusX, statusY1);
      process.stdout.write(line1);
      if (statusY2) {
        term.moveTo(statusX, statusY2);
        process.stdout.write(line2);
      }
    }
  }

  /**
   * Draw input area - only redraws if input changed
   * Now supports multi-line input (1-5 lines based on content)
   */
  function drawInput(force: boolean = false) {
    const layout = getLayout(state.inputBuffer, state.mode);
    const inputHeight = layout.inputArea.height;

    const inputChanged =
      state.inputBuffer !== tracker.lastInputBuffer ||
      state.mode !== tracker.lastMode ||
      state.cursorPos !== tracker.lastCursorPos;
    const heightChanged = inputHeight !== tracker.lastInputHeight;

    if (!force && !inputChanged && !heightChanged) return;

    // Handle input height changes - need to clear old areas and redraw context/status
    if (heightChanged) {
      // Calculate where the OLD context bar was (before height change)
      const oldInputHeight = tracker.lastInputHeight;
      const oldInputY = layout.height - oldInputHeight + 1;
      const oldStatusY = oldInputY - 1;
      const oldContextY = oldStatusY - 1;

      // New context position
      const newContextY = layout.contextBar.y;

      // Clear from the higher of old/new context positions down to bottom
      // This ensures ghost lines are cleared when input shrinks
      const clearStartY = Math.min(oldContextY, newContextY);

      for (let y = clearStartY; y <= layout.height; y++) {
        if (y >= 1) {
          term.moveTo(layout.inputArea.x, y);
          // Only clear chat area width, not the tile scene on the left
          process.stdout.write(' '.repeat(layout.inputArea.width));
        }
      }

      tracker.lastInputHeight = inputHeight;

      // Redraw context and status at their new positions
      drawContext(true);
      drawStatus(true);
    }

    tracker.lastInputBuffer = state.inputBuffer;
    tracker.lastMode = state.mode;
    tracker.lastCursorPos = state.cursorPos;

    const inputX = layout.inputArea.x;
    const inputY = layout.inputArea.y;
    const inputWidth = layout.inputArea.width;

    // Clear all input lines
    for (let i = 0; i < inputHeight; i++) {
      term.moveTo(inputX, inputY + i);
      process.stdout.write(' '.repeat(inputWidth));
    }

    // Wrap input text for multi-line display
    const promptWidth = 2; // "> " or ": "
    const textWidth = inputWidth - promptWidth - 1; // -1 for cursor space
    const wrappedLines = wrapInputText(state.inputBuffer, textWidth);

    // Calculate cursor position in wrapped lines
    // Need to map state.cursorPos (char index in inputBuffer) to (line, col) in wrappedLines
    let cursorLine = 0;
    let cursorCol = 0;

    if (state.inputBuffer.length > 0) {
      // Walk through the input buffer to find which wrapped line the cursor is on
      const paragraphs = state.inputBuffer.split('\n');
      let charIndex = 0;
      let lineIndex = 0;
      let found = false;

      outer: for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
        const para = paragraphs[pIdx];

        if (para.length === 0) {
          // Empty paragraph (from newline)
          if (state.cursorPos === charIndex) {
            cursorLine = lineIndex;
            cursorCol = 0;
            found = true;
            break;
          }
          lineIndex++;
        } else {
          // Wrap the paragraph
          for (let i = 0; i < para.length; i += textWidth) {
            const lineEnd = Math.min(i + textWidth, para.length);

            // Check if cursor is in this line segment
            if (state.cursorPos >= charIndex + i && state.cursorPos < charIndex + lineEnd) {
              cursorLine = lineIndex;
              cursorCol = state.cursorPos - charIndex - i;
              found = true;
              break outer;
            }
            // Check if cursor is exactly at the end of this line segment (but before next line)
            if (state.cursorPos === charIndex + lineEnd && lineEnd === para.length) {
              // Cursor at end of paragraph - show at end of this line
              cursorLine = lineIndex;
              cursorCol = lineEnd - i;
              found = true;
              break outer;
            }
            lineIndex++;
          }
          charIndex += para.length;
        }

        // Add 1 for newline between paragraphs (except after last)
        if (pIdx < paragraphs.length - 1) {
          if (state.cursorPos === charIndex) {
            // Cursor is right at the newline - show at start of next line
            cursorLine = lineIndex;
            cursorCol = 0;
            found = true;
            break;
          }
          charIndex++; // For the \n
        }
      }

      // Handle cursor at very end of input
      if (!found || state.cursorPos >= state.inputBuffer.length) {
        cursorLine = wrappedLines.length - 1;
        cursorCol = wrappedLines[cursorLine]?.length || 0;
      }
    }

    // Adjust scroll to keep cursor visible
    let adjustedStartLine = Math.max(0, wrappedLines.length - inputHeight);
    if (cursorLine < adjustedStartLine) {
      adjustedStartLine = cursorLine;
    } else if (cursorLine >= adjustedStartLine + inputHeight) {
      adjustedStartLine = cursorLine - inputHeight + 1;
    }

    // Get final visible lines after scroll adjustment
    const visibleLines = wrappedLines.slice(adjustedStartLine, adjustedStartLine + inputHeight);

    // Draw each line
    for (let i = 0; i < visibleLines.length; i++) {
      term.moveTo(inputX, inputY + i);
      if (i === 0 && adjustedStartLine === 0) {
        // First line gets the prompt
        if (state.mode === 'INSERT') {
          term.cyan('> ');
        } else {
          term.blue(': ');
        }
      } else {
        // Continuation lines get indent to align with text
        process.stdout.write('  ');
      }
      term.white(visibleLines[i]);
    }

    // Draw cursor at calculated position (only in INSERT mode)
    if (state.mode === 'INSERT') {
      const visibleCursorLine = cursorLine - adjustedStartLine;
      if (visibleCursorLine >= 0 && visibleCursorLine < inputHeight) {
        term.moveTo(inputX + promptWidth + cursorCol, inputY + visibleCursorLine);
        term.bgWhite.black(' ');
      }
    }
  }

  /**
   * Wrap input text for multi-line display
   */
  function wrapInputText(text: string, width: number): string[] {
    if (!text || width <= 0) return [''];

    const lines: string[] = [];
    const paragraphs = text.split('\n');

    for (const para of paragraphs) {
      if (para.length === 0) {
        lines.push('');
      } else {
        // Break paragraph into lines of 'width' characters
        for (let i = 0; i < para.length; i += width) {
          lines.push(para.substring(i, i + width));
        }
      }
    }

    return lines.length > 0 ? lines : [''];
  }

  // Debounce tracking for fullDraw (prevents signal storm on dtach reattach)
  let lastFullDrawTime = 0;
  const FULL_DRAW_DEBOUNCE_MS = 50;

  /**
   * Full redraw of all components
   */
  function fullDraw() {
    // Skip all drawing when disabled (suspended/detached)
    if (!state.drawingEnabled) return;

    // Skip drawing if no TTY (dtach detached)
    if (!process.stdout.isTTY) return;

    // Debounce rapid fullDraw calls (signal storm on dtach reattach)
    const now = Date.now();
    if (now - lastFullDrawTime < FULL_DRAW_DEBOUNCE_MS) return;
    lastFullDrawTime = now;

    // Reset trackers to force redraw
    tracker.lastTileFrame = -1;
    tracker.lastScrollOffset = -1;
    tracker.lastInputBuffer = '';
    tracker.lastMode = state.mode;
    tracker.lastMessageCount = -1;
    tracker.lastContextPercent = -1;
    tracker.lastOrchestratorPercent = null;
    tracker.lastInputHeight = 1;

    term.clear();

    // Draw requirements overlay if active, otherwise normal UI
    if (requirementsOverlay?.isActive()) {
      requirementsOverlay.draw();
    } else {
      drawTiles(true);
      drawChat(true);
      drawContext(true);
      drawStatus(true);
      drawInput(true);
    }
  }

  // ============================================================================
  // Requirements Overlay (deferred initialization)
  // ============================================================================

  /**
   * Draw tiles without checking overlay state (for use by overlay itself)
   */
  function drawTilesForOverlay(): void {
    if (!state.tileset) return;
    const layout = getLayout(state.inputBuffer, state.mode);

    // Draw filler rows above the scene
    const rowsAbove = layout.tileArea.fillerRowsAbove;
    if (rowsAbove > 0) {
      const fillerTileRowsAbove = Math.ceil(rowsAbove / CHAR_HEIGHT);
      for (let tileRow = 0; tileRow < fillerTileRowsAbove; tileRow++) {
        const fillerLines = getFillerRow(state.tileset, tileRow);
        for (let charRow = CHAR_HEIGHT - 1; charRow >= 0; charRow--) {
          const screenY =
            layout.tileArea.y - 1 - tileRow * CHAR_HEIGHT - (CHAR_HEIGHT - 1 - charRow);
          if (screenY >= 1) {
            term.moveTo(layout.tileArea.x, screenY);
            process.stdout.write(fillerLines[charRow] + RESET);
          }
        }
      }
    }

    // Get all registered sprites and create scene from them
    const allSprites = getAllSprites();
    const background = createScene(allSprites);

    // Render scene to ANSI string using sprite-based API
    const sceneStr = renderScene(state.tileset, background, allSprites);

    // Split by lines and write each line
    const lines = sceneStr.split('\n');
    for (let i = 0; i < lines.length; i++) {
      term.moveTo(layout.tileArea.x, layout.tileArea.y + i);
      process.stdout.write(lines[i] + RESET);
    }

    // Draw filler rows below the scene
    const rowsBelow = layout.tileArea.fillerRowsBelow;
    if (rowsBelow > 0) {
      const fillerTileRowsBelow = Math.ceil(rowsBelow / CHAR_HEIGHT);
      for (let tileRow = 0; tileRow < fillerTileRowsBelow; tileRow++) {
        const fillerLines = getFillerRow(state.tileset, tileRow + 100);
        for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
          const screenY = layout.tileArea.y + TILE_AREA_HEIGHT + tileRow * CHAR_HEIGHT + charRow;
          if (screenY <= layout.height) {
            term.moveTo(layout.tileArea.x, screenY);
            process.stdout.write(fillerLines[charRow] + RESET);
          }
        }
      }
    }
  }

  // File selection callback - called when user selects a file or cancels
  function onRequirementsFileSelected(filePath: string | null): void {
    if (filePath) {
      appState.requirementsPath = filePath;
    }
    fullDraw();

    // Signal that requirements are ready (router can start now)
    if (requirementsReadyCallback) {
      requirementsReadyCallback();
      requirementsReadyCallback = null;
    }

    // Continue the entrance sequence
    continueEntranceAfterRequirements();
  }

  // Now we can initialize the requirements overlay
  requirementsOverlay = createRequirementsOverlay({
    term,
    getTileset: () => state.tileset,
    getLayout: () => getLayout(state.inputBuffer, state.mode),
    drawTiles: drawTilesForOverlay,
    onFileSelected: onRequirementsFileSelected,
    humanSprite,
  });

  // Initialize the log viewer
  logViewer = createLogViewer({
    term,
    getWidth: () => term.width || 180,
    getHeight: () => term.height || 50,
    onClose: () => fullDraw(),
    onCloseAndExit: () => {
      fullDraw();
      state.pendingExit = true;
      drawStatus(true);
    },
    onCloseAndSuspend: () => {
      suspendProcess();
    },
  });

  // ============================================================================
  // Helper Functions
  // ============================================================================

  function getMessagePrefix(msg: Message): string {
    if (msg.speaker === 'human') {
      return 'You: ';
    } else if (msg.speaker === 'arbiter') {
      return 'Arbiter: ';
    } else if (msg.speaker === 'orchestrator' && msg.orchestratorNumber) {
      return `Conjuring ${toRoman(msg.orchestratorNumber)}: `;
    } else if (msg.speaker === 'system') {
      return ''; // No prefix for system/narrator messages
    }
    return '';
  }

  function getMessageColor(speaker: Speaker): string {
    switch (speaker) {
      case 'human':
        return COLORS.human;
      case 'arbiter':
        return COLORS.arbiter;
      case 'orchestrator':
        return COLORS.orchestrator;
      case 'system':
        return COLORS.system;
      default:
        return COLORS.reset;
    }
  }

  function wrapText(text: string, width: number): string[] {
    const lines: string[] = [];

    // First split by newlines to preserve paragraph breaks
    const paragraphs = text.split('\n');

    for (const paragraph of paragraphs) {
      const words = paragraph.split(' ');
      let currentLine = '';

      for (const word of words) {
        // Handle words longer than width by breaking them
        if (word.length > width) {
          if (currentLine) {
            lines.push(currentLine);
            currentLine = '';
          }
          // Break the long word into chunks
          for (let i = 0; i < word.length; i += width) {
            lines.push(word.substring(i, i + width));
          }
          continue;
        }

        if (currentLine.length + word.length + 1 <= width) {
          currentLine += (currentLine ? ' ' : '') + word;
        } else {
          if (currentLine) lines.push(currentLine);
          currentLine = word;
        }
      }
      if (currentLine) lines.push(currentLine);
      // Empty paragraph becomes empty line
      if (paragraph === '') lines.push('');
    }

    return lines.length > 0 ? lines : [''];
  }

  function addMessage(speaker: Speaker, text: string, orchestratorNumber?: number) {
    state.messages.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      speaker,
      orchestratorNumber,
      text,
      timestamp: new Date(),
    });

    // Show chat bubble on the speaker's sprite (5 second duration)
    if (speaker === 'human') {
      humanSprite.chatting(5000);
    } else if (speaker === 'arbiter') {
      arbiterSprite.chatting(5000);
    } else if (speaker === 'orchestrator') {
      // First visible demon shows the chat bubble
      const visibleDemon = demons.find((d) => d.visible);
      if (visibleDemon) visibleDemon.chatting(5000);
    }
    // system messages don't show a chat bubble

    // Auto-scroll to bottom using single source of truth
    const layout = getLayout(state.inputBuffer, state.mode);
    const renderedLines = getRenderedChatLines(layout.chatArea.width);
    state.scrollOffset = Math.max(0, renderedLines.length - layout.chatArea.height);

    drawChat();
    drawTiles(true); // Force redraw tiles for chat bubble
    playSfx('quickNotice');
  }

  // ============================================================================
  // Input Handling
  // ============================================================================

  function handleKeypress(key: string) {
    if (state.mode === 'INSERT') {
      handleInsertModeKey(key);
    } else {
      handleNormalModeKey(key);
    }
  }

  /**
   * Calculate the visual line and column position for a cursor index
   * @param text The input buffer text
   * @param cursorPos The cursor position (index into text)
   * @param lineWidth The width of each line for wrapping
   * @returns { line: number, col: number, totalLines: number }
   */
  function getCursorLineCol(
    text: string,
    cursorPos: number,
    lineWidth: number,
  ): { line: number; col: number; totalLines: number } {
    if (!text || lineWidth <= 0) {
      return { line: 0, col: 0, totalLines: 1 };
    }

    const paragraphs = text.split('\n');
    let charIndex = 0;
    let lineIndex = 0;

    for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
      const para = paragraphs[pIdx];

      if (para.length === 0) {
        // Empty paragraph
        if (cursorPos === charIndex) {
          return { line: lineIndex, col: 0, totalLines: countTotalLines(text, lineWidth) };
        }
        lineIndex++;
      } else {
        // Non-empty paragraph - may wrap across multiple lines
        for (let i = 0; i < para.length; i += lineWidth) {
          const lineStart = charIndex + i;
          const lineEnd = charIndex + Math.min(i + lineWidth, para.length);

          if (cursorPos >= lineStart && cursorPos < lineEnd) {
            return {
              line: lineIndex,
              col: cursorPos - lineStart,
              totalLines: countTotalLines(text, lineWidth),
            };
          }
          // Cursor at end of this wrapped segment (and it's the last segment of paragraph)
          if (cursorPos === lineEnd && i + lineWidth >= para.length) {
            return {
              line: lineIndex,
              col: cursorPos - lineStart,
              totalLines: countTotalLines(text, lineWidth),
            };
          }
          lineIndex++;
        }
        charIndex += para.length;
      }

      // Handle newline between paragraphs
      if (pIdx < paragraphs.length - 1) {
        if (cursorPos === charIndex) {
          // Cursor at the newline - show at start of next line
          return { line: lineIndex, col: 0, totalLines: countTotalLines(text, lineWidth) };
        }
        charIndex++; // For the \n
      }
    }

    // Cursor at very end
    return {
      line: lineIndex - 1,
      col: text.length - charIndex + (paragraphs[paragraphs.length - 1]?.length || 0),
      totalLines: countTotalLines(text, lineWidth),
    };
  }

  /**
   * Count total wrapped lines for a text
   */
  function countTotalLines(text: string, lineWidth: number): number {
    if (!text || lineWidth <= 0) return 1;
    const paragraphs = text.split('\n');
    let total = 0;
    for (const para of paragraphs) {
      total += para.length === 0 ? 1 : Math.ceil(para.length / lineWidth);
    }
    return Math.max(1, total);
  }

  /**
   * Convert a line/column position back to a cursor index
   * @param text The input buffer text
   * @param targetLine The target line number
   * @param targetCol The target column (will be clamped to line length)
   * @param lineWidth The width of each line for wrapping
   * @returns The cursor position (index into text)
   */
  function lineToCursorPos(
    text: string,
    targetLine: number,
    targetCol: number,
    lineWidth: number,
  ): number {
    if (!text || lineWidth <= 0) return 0;

    const paragraphs = text.split('\n');
    let charIndex = 0;
    let lineIndex = 0;

    for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
      const para = paragraphs[pIdx];

      if (para.length === 0) {
        if (lineIndex === targetLine) {
          return charIndex; // Can only be at col 0 for empty line
        }
        lineIndex++;
      } else {
        for (let i = 0; i < para.length; i += lineWidth) {
          if (lineIndex === targetLine) {
            const lineLen = Math.min(lineWidth, para.length - i);
            const col = Math.min(targetCol, lineLen);
            return charIndex + i + col;
          }
          lineIndex++;
        }
        charIndex += para.length;
      }

      if (pIdx < paragraphs.length - 1) {
        charIndex++; // For the \n
      }
    }

    return text.length; // Default to end
  }

  function handleInsertModeKey(key: string) {
    switch (key) {
      case 'ESCAPE':
        state.mode = 'NORMAL';
        drawStatus(true);
        drawInput(true);
        break;

      case 'ENTER':
        // Check if character before cursor is a backslash (line continuation)
        if (state.cursorPos > 0 && state.inputBuffer[state.cursorPos - 1] === '\\') {
          // Remove the backslash and insert newline
          state.inputBuffer =
            state.inputBuffer.slice(0, state.cursorPos - 1) +
            '\n' +
            state.inputBuffer.slice(state.cursorPos);
          // cursorPos stays the same (backslash removed, newline added = net zero change)
          drawInput();
          break;
        }
        // Block input until arbiter has spoken first
        if (!state.arbiterHasSpoken) {
          break;
        }
        // Normal submit behavior
        if (state.inputBuffer.trim()) {
          const text = state.inputBuffer.trim();
          state.inputBuffer = '';
          state.cursorPos = 0;
          if (inputCallback) {
            inputCallback(text);
          }
        }
        drawInput(true);
        break;

      case 'BACKSPACE':
        if (state.cursorPos > 0) {
          // Delete character before cursor
          state.inputBuffer =
            state.inputBuffer.slice(0, state.cursorPos - 1) +
            state.inputBuffer.slice(state.cursorPos);
          state.cursorPos--;
        }
        drawInput();
        break;

      case 'DELETE':
        if (state.cursorPos < state.inputBuffer.length) {
          // Delete character at cursor
          state.inputBuffer =
            state.inputBuffer.slice(0, state.cursorPos) +
            state.inputBuffer.slice(state.cursorPos + 1);
        }
        drawInput();
        break;

      case 'LEFT':
        if (state.cursorPos > 0) {
          state.cursorPos--;
          drawInput();
        }
        break;

      case 'RIGHT':
        if (state.cursorPos < state.inputBuffer.length) {
          state.cursorPos++;
          drawInput();
        }
        break;

      case 'HOME':
        state.cursorPos = 0;
        drawInput();
        break;

      case 'END':
        state.cursorPos = state.inputBuffer.length;
        drawInput();
        break;

      case 'UP': {
        const layout = getLayout(state.inputBuffer, state.mode);
        const textWidth = layout.inputArea.width - 3; // Match drawInput calculation
        const { line, col } = getCursorLineCol(state.inputBuffer, state.cursorPos, textWidth);

        if (line > 0) {
          // Move to previous line, same column (or end if shorter)
          state.cursorPos = lineToCursorPos(state.inputBuffer, line - 1, col, textWidth);
          drawInput();
        }
        break;
      }

      case 'DOWN': {
        const layout = getLayout(state.inputBuffer, state.mode);
        const textWidth = layout.inputArea.width - 3;
        const { line, col, totalLines } = getCursorLineCol(
          state.inputBuffer,
          state.cursorPos,
          textWidth,
        );

        if (line < totalLines - 1) {
          // Move to next line, same column (or end if shorter)
          state.cursorPos = lineToCursorPos(state.inputBuffer, line + 1, col, textWidth);
          drawInput();
        }
        break;
      }

      default:
        // Regular character
        if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) < 127) {
          // Insert character at cursor position
          state.inputBuffer =
            state.inputBuffer.slice(0, state.cursorPos) +
            key +
            state.inputBuffer.slice(state.cursorPos);
          state.cursorPos++;
          drawInput();
        }
        break;
    }
  }

  function handleNormalModeKey(key: string) {
    switch (key) {
      case 'i':
      case 'ENTER': {
        state.mode = 'INSERT';
        // Auto-scroll to bottom when entering insert mode
        const layoutIns = getLayout(state.inputBuffer, state.mode);
        const renderedLinesIns = getRenderedChatLines(layoutIns.chatArea.width);
        state.scrollOffset = Math.max(0, renderedLinesIns.length - layoutIns.chatArea.height);
        drawChat();
        drawStatus(true);
        drawInput(true);
        break;
      }

      case 'j':
      case 'DOWN':
        // Scroll down
        state.scrollOffset++;
        drawChat();
        break;

      case 'k':
      case 'UP':
        // Scroll up
        state.scrollOffset = Math.max(0, state.scrollOffset - 1);
        drawChat();
        break;

      case 'g':
        // Scroll to top
        state.scrollOffset = 0;
        drawChat();
        break;

      case 'G': {
        // Scroll to bottom using single source of truth
        const layoutG = getLayout(state.inputBuffer, state.mode);
        const renderedLinesG = getRenderedChatLines(layoutG.chatArea.width);
        state.scrollOffset = Math.max(0, renderedLinesG.length - layoutG.chatArea.height);
        drawChat();
        break;
      }

      case 'b':
      case 'CTRL_B': {
        // Page up (back)
        const layoutB = getLayout(state.inputBuffer, state.mode);
        state.scrollOffset = Math.max(0, state.scrollOffset - layoutB.chatArea.height);
        drawChat();
        break;
      }

      case 'f':
      case 'CTRL_F': {
        // Page down (forward)
        const layoutF = getLayout(state.inputBuffer, state.mode);
        const renderedLinesF = getRenderedChatLines(layoutF.chatArea.width);
        const maxScrollF = Math.max(0, renderedLinesF.length - layoutF.chatArea.height);
        state.scrollOffset = Math.min(maxScrollF, state.scrollOffset + layoutF.chatArea.height);
        drawChat();
        break;
      }

      case 'u':
      case 'CTRL_U': {
        // Half page up
        const layoutU = getLayout(state.inputBuffer, state.mode);
        const halfPageU = Math.floor(layoutU.chatArea.height / 2);
        state.scrollOffset = Math.max(0, state.scrollOffset - halfPageU);
        drawChat();
        break;
      }

      case 'd':
      case 'CTRL_D': {
        // Half page down
        const layoutD = getLayout(state.inputBuffer, state.mode);
        const renderedLinesD = getRenderedChatLines(layoutD.chatArea.width);
        const maxScrollD = Math.max(0, renderedLinesD.length - layoutD.chatArea.height);
        const halfPageD = Math.floor(layoutD.chatArea.height / 2);
        state.scrollOffset = Math.min(maxScrollD, state.scrollOffset + halfPageD);
        drawChat();
        break;
      }

      case 'o':
        // Open debug log viewer
        logViewer.open();
        break;

      case 'm':
        // Toggle music
        toggleMusic();
        drawStatus(true);
        break;

      case 's':
        // Toggle sound effects
        toggleSfx();
        drawStatus(true);
        break;

      default:
        break;
    }
  }

  // ============================================================================
  // Animation
  // ============================================================================

  function startAnimation() {
    animationInterval = setInterval(() => {
      // State updates always run (timers, counters) even when drawing disabled
      state.animationFrame = (state.animationFrame + 1) % 8;
      // Increment blink cycle every full animation cycle (for slower chat blink)
      if (state.animationFrame === 0) {
        state.blinkCycle = (state.blinkCycle + 1) % 8;
      }

      // Auto-clear expired tool indicator
      if (state.currentTool && Date.now() - state.lastToolTime > 5000) {
        state.currentTool = null;
        state.toolCallCount = 0;
      }

      // Skip actual drawing when disabled (suspended/detached) or no TTY
      if (!state.drawingEnabled || !process.stdout.isTTY) return;

      // Draw if waiting or if any sprite has an active animation
      if (state.waitingFor !== 'none' || hasActiveAnimations()) {
        drawTiles();
        // Only update chat when waiting (not for sprite-only animations)
        if (state.waitingFor !== 'none') {
          drawChat(); // Update chat working indicator
        }
      }
    }, ANIMATION_INTERVAL);
  }

  function stopAnimation() {
    if (animationInterval) {
      clearInterval(animationInterval);
      animationInterval = null;
    }
  }

  // ============================================================================
  // Summon Sequence Functions
  // ============================================================================

  /**
   * Process the summon queue: walk to fire position, show spellbook, spawn queued demons.
   * Uses sprite-based animations instead of the old state machine.
   */
  async function processSummonQueue() {
    if (isSummoning) return; // Already processing
    if (pendingDemons.length === 0) return; // Nothing to process

    isSummoning = true;

    // Walk to fire position if not already there
    if (!arbiterSprite.isAt({ row: 3, col: 4 })) {
      await arbiterSprite.walk({ row: 3, col: 4 });
      drawTiles(true);
    }

    // Show spellbook if not visible
    if (!spellbookSprite.visible) {
      await spellbookSprite.physicalSpawn();
      drawTiles(true);
    }

    // Spawn all queued demons
    while (pendingDemons.length > 0) {
      const demonIndex = pendingDemons.shift();
      if (demonIndex === undefined) break;
      if (demonIndex >= 0 && demonIndex < demons.length) {
        await new Promise((r) => setTimeout(r, 500)); // Brief delay
        await demons[demonIndex].magicSpawn();
        drawTiles(true);
      }
    }

    isSummoning = false;
  }

  /**
   * Queue a demon to spawn. Fires off processSummonQueue without awaiting.
   * @param demonIndex - 0-indexed demon index
   */
  function queueDemonSpawn(demonIndex: number) {
    pendingDemons.push(demonIndex);
    processSummonQueue(); // Fire and forget - don't await
  }

  /**
   * Dismiss all orchestrators: clear demons, hide spellbook, walk back to scroll.
   * Uses sprite-based animations.
   */
  async function dismissAllOrchestrators() {
    // Clear any pending spawns
    pendingDemons = [];

    // Wait for any in-progress summon to finish
    while (isSummoning) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // Despawn all visible demons
    const despawnPromises = demons.filter((d) => d.visible).map((d) => d.magicDespawn());
    await Promise.all(despawnPromises);
    drawTiles(true);

    // Hide spellbook
    if (spellbookSprite.visible) {
      spellbookSprite.visible = false; // Instant hide
      drawTiles(true);
    }

    // Walk back to scroll position
    await arbiterSprite.walk({ row: 2, col: 3 });
    drawTiles(true);
  }

  /**
   * Continue the entrance sequence after requirements selection
   * Called either directly from entrance (no requirements prompt) or after user selects file
   */
  async function continueEntranceAfterRequirements() {
    // Scroll drops from inventory
    await scrollSprite.physicalSpawn();
    drawTiles(true);

    // Arbiter walks to scroll
    await arbiterSprite.walk({ row: 2, col: 3 });
    drawTiles(true);

    // Arbiter notices scroll (alert indicator)
    await arbiterSprite.alarmed(1500);
    drawTiles(true);

    // Entrance complete
    entranceComplete = true;
    if (pendingArbiterMessage) {
      addMessage('arbiter', pendingArbiterMessage);
      pendingArbiterMessage = null;
    }
  }

  /**
   * Run the full entrance sequence:
   * 1. Human walks in from left (col 0 → 1)
   * 2. Human hops twice (surprised)
   * 3. Arbiter hops twice (notices visitor)
   * 4. Requirements prompt shows (if needed) - arbiter still at starting position
   * 5. After user selects file (or if no prompt needed), arbiter walks to human
   */
  async function runEntranceSequence() {
    // Show "the arbiter approaches" message
    addMessage('system', 'The arbiter approaches...');

    // Human walks in from left edge to col 1
    await humanSprite.walk({ row: 2, col: 1 });
    drawTiles(true);

    // Pause a beat before hopping
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Human hops twice (surprised)
    await humanSprite.hop(2);
    drawTiles(true);

    // Arbiter hops twice (notices visitor)
    await arbiterSprite.hop(2);
    drawTiles(true);

    // Check if we need requirements prompt
    if (needsRequirementsPrompt) {
      // Show requirements overlay BEFORE arbiter walks
      requirementsOverlay.show();
      // Wait for user to select file (this happens via callback)
      // The callback will call continueEntranceAfterRequirements()
    } else {
      // No requirements prompt needed (CLI arg provided)
      // Signal ready and continue
      if (requirementsReadyCallback) {
        requirementsReadyCallback();
        requirementsReadyCallback = null;
      }
      await continueEntranceAfterRequirements();
    }
  }

  // ============================================================================
  // Router Callbacks
  // ============================================================================

  function getRouterCallbacks(): RouterCallbacks {
    return createRouterCallbacks({
      getState: () => state,
      isEntranceComplete: () => entranceComplete,
      getPendingArbiterMessage: () => pendingArbiterMessage,
      setPendingArbiterMessage: (msg) => {
        pendingArbiterMessage = msg;
      },
      humanSprite,
      arbiterSprite,
      demons,
      smokeSprite,
      addMessage,
      drawTiles,
      drawChat,
      drawContext,
      queueDemonSpawn,
      dismissAllOrchestrators,
    });
  }

  // ============================================================================
  // Public Interface
  // ============================================================================

  async function start(): Promise<void> {
    if (isRunning) return;
    isRunning = true;

    // Remove any existing SIGINT handlers (terminal-kit or others may add them)
    process.removeAllListeners('SIGINT');

    // Set up global SIGINT handler to prevent default exit behavior
    // terminal-kit handles CTRL_C as a key event, but this catches any SIGINT that slips through
    process.on('SIGINT', () => {
      if (!state.pendingExit) {
        state.pendingExit = true;
        drawStatus(true);
      }
    });

    // Handle SIGCONT (resume after suspend or dtach reattach) - restore TUI state
    process.on('SIGCONT', () => {
      // Toggle raw mode off/on to reset termios (workaround for OS resetting attrs)
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
        process.stdin.setRawMode(true);
      }
      // Re-init terminal-kit and redraw
      term.grabInput(true);
      term.fullscreen(true);
      term.hideCursor();
      // Re-enable drawing and do a clean full redraw
      state.drawingEnabled = true;
      fullDraw();
    });

    // Handle SIGHUP (dtach reattach may send this)
    process.on('SIGHUP', () => {
      // Toggle raw mode and redraw - terminal might have reconnected
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
        process.stdin.setRawMode(true);
      }
      term.grabInput(true);
      fullDraw();
    });

    // Handle SIGWINCH (terminal resize, dtach sends this on reattach with REDRAW_WINCH)
    process.on('SIGWINCH', () => {
      // Toggle raw mode and redraw
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
        process.stdin.setRawMode(true);
      }
      term.grabInput(true);
      fullDraw();
    });

    // Clear the debug log file for this session
    try {
      const dir = path.dirname(DEBUG_LOG_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(DEBUG_LOG_PATH, `=== Arbiter Session ${new Date().toISOString()} ===\n\n`);
    } catch (_err) {
      // Ignore errors
    }

    // Load tileset
    try {
      state.tileset = await loadTileset();
    } catch (err) {
      console.error('Failed to load tileset:', err);
      throw err;
    }

    // Enter fullscreen mode
    term.fullscreen(true);
    term.hideCursor();

    // Initial draw (character at column 0 - entering from the path)
    fullDraw();

    // Start animation timers (both sprite animation loop and legacy animation)
    startAnimationLoop();
    startAnimation();

    // Always run the full entrance sequence
    // Human walks in, both characters hop, arbiter walks to human
    // Requirements overlay shows AFTER entrance completes (if no CLI arg)
    runEntranceSequence();

    // Set up input handling
    term.grabInput(true);

    // Raw stdin handler for Ctrl-\ (0x1c) - terminal-kit doesn't emit this as a key
    // This is used for dtach detachment
    process.stdin.on('data', (data: Buffer) => {
      if (data.includes(0x1c)) {
        // Ctrl-\ = ASCII 28 = 0x1c
        // Disable drawing before detach (same as suspend)
        state.drawingEnabled = false;
        process.kill(process.pid, 'SIGQUIT');
      }
    });

    term.on('key', (key: string) => {
      // Handle requirements overlay first (takes priority)
      if (requirementsOverlay.isActive()) {
        // Allow CTRL_C to exit even during overlay
        if (key === 'CTRL_C') {
          state.pendingExit = true;
          drawStatus(true);
          return;
        }
        // Allow CTRL_Z to suspend during overlay
        if (key === 'CTRL_Z') {
          suspendProcess();
          return;
        }
        requirementsOverlay.handleKey(key);
        return;
      }

      // Handle exit confirmation mode
      if (state.pendingExit) {
        if (key === 'y' || key === 'Y') {
          // Call exit callback if registered, otherwise exit directly
          if (exitCallback) {
            exitCallback();
          } else {
            stop();
            process.exit(0);
          }
        } else {
          // Cancel exit
          state.pendingExit = false;
          drawStatus(true);
        }
        return;
      }

      if (key === 'CTRL_C') {
        // Show exit confirmation
        state.pendingExit = true;
        drawStatus(true);
        return;
      }

      if (key === 'CTRL_Z') {
        suspendProcess();
        return;
      }
      // Note: CTRL_BACKSLASH (Ctrl-\) is handled via raw stdin listener above
      handleKeypress(key);
    });

    // Handle resize
    term.on('resize', () => {
      fullDraw();
    });
  }

  function stop(): void {
    if (!isRunning) return;

    stopAnimationLoop();
    stopAnimation();
    exitTerminal();

    // Print session IDs on exit
    console.log('\n\x1b[1mSession IDs:\x1b[0m');
    if (appState.arbiterSessionId) {
      console.log(`  Arbiter: \x1b[33m${appState.arbiterSessionId}\x1b[0m`);
    } else {
      console.log('  Arbiter: \x1b[2m(no session)\x1b[0m');
    }
    if (appState.currentOrchestrator) {
      console.log(`  Orchestrator: \x1b[36m${appState.currentOrchestrator.sessionId}\x1b[0m`);
    }
    console.log('');

    // Show crash count if any
    if (appState.crashCount > 0) {
      console.log(
        `\n\x1b[33m⚠ Session had ${appState.crashCount} crash${appState.crashCount > 1 ? 'es' : ''} (recovered)\x1b[0m`,
      );
    }

    isRunning = false;
  }

  function onInput(callback: (text: string) => void): void {
    inputCallback = callback;
  }

  function onExit(callback: () => void): void {
    exitCallback = callback;
  }

  function onRequirementsReady(callback: () => void): void {
    requirementsReadyCallback = callback;
  }

  function startWaiting(waitingFor: 'arbiter' | 'orchestrator'): void {
    // Ignore during entrance sequence
    if (!entranceComplete) return;

    state.waitingFor = waitingFor;

    // Hop for 3 seconds (6 hops)
    const target = waitingFor === 'arbiter' ? arbiterSprite : demons[0];
    if (target) {
      target.hop(6); // Fire and forget
    }

    // Start cauldron bubbling
    smokeSprite.startBubbling();

    drawTiles(true);

    // Auto-scroll to show the working indicator using single source of truth
    const layout = getLayout(state.inputBuffer, state.mode);
    const renderedLines = getRenderedChatLines(layout.chatArea.width);
    state.scrollOffset = Math.max(0, renderedLines.length - layout.chatArea.height);
    drawChat(true);
  }

  function stopWaiting(): void {
    state.waitingFor = 'none';

    // Stop any ongoing animations
    arbiterSprite.stopAnimation();
    for (const d of demons) d.stopAnimation();

    // Stop bubbling
    smokeSprite.stopBubbling();

    drawTiles(true);
    drawChat(true); // Clear the working indicator
  }

  return {
    start,
    stop,
    getRouterCallbacks,
    onInput,
    onExit,
    onRequirementsReady,
    startWaiting,
    stopWaiting,
  };
}
