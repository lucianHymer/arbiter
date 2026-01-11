/**
 * Terminal-Kit based TUI using Strategy 5 (Minimal Redraws)
 *
 * This replaces the Ink-based TUI with a terminal-kit implementation
 * that uses minimal redraws for flicker-free animation and input handling.
 */

import termKit from 'terminal-kit';
import * as fs from 'fs';
import * as path from 'path';
import { Fzf } from 'fzf';
import {
  Tileset,
  TILE,
  TILE_SIZE,
  CHAR_HEIGHT,
  RESET,
  loadTileset,
  extractTile,
  compositeTiles,
  renderTile,
  RGB,
} from './tileset.js';
import {
  SceneState,
  HopState,
  TileSpec,
  createInitialSceneState,
  createScene,
  renderScene,
} from './scene.js';
import type { RouterCallbacks, DebugLogEntry } from '../router.js';
import type { AppState } from '../state.js';
import { toRoman } from '../state.js';
import type { WaitingState, Message, Speaker } from './types.js';
import { playSfx } from '../sound.js';

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

  // Scene state
  sceneState: SceneState;

  // Chat messages
  messages: Message[];
  scrollOffset: number;

  // Input state
  inputBuffer: string;
  cursorPos: number;  // Cursor position (index into inputBuffer)
  mode: 'NORMAL' | 'INSERT';

  // Status info
  arbiterContextPercent: number;
  orchestratorContextPercent: number | null;
  currentTool: string | null;
  toolCallCount: number;
  lastToolTime: number;  // timestamp when tool was last set

  // Tool indicator (shown between messages)
  recentTools: string[];  // Last 2 tools used
  toolCountSinceLastMessage: number;  // Total tool calls since last chat message
  showToolIndicator: boolean;  // Whether to show the tool indicator

  // Animation state
  animationFrame: number;
  blinkCycle: number; // Slower counter for chat blink (increments every animation cycle)
  waitingFor: WaitingState;
  chatBubbleStartTime: number; // Timestamp when chat bubble was shown (for 5s timeout)

  // Exit confirmation state
  pendingExit: boolean;

  // Crash tracking
  crashCount: number;

  // Input lock until arbiter speaks
  arbiterHasSpoken: boolean;

  // Requirements overlay state
  requirementsOverlay: 'none' | 'prompt' | 'picker' | 'rat-transform';
  requirementsFiles: string[];
  requirementsFilteredFiles: string[];
  requirementsSearchQuery: string;
  requirementsSelectedIndex: number;
  requirementsCursorPos: number;
  requirementsTilesDrawn: boolean;  // Flag to avoid redrawing tiles on every keystroke
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

// Scene dimensions
const SCENE_WIDTH = 7;
const SCENE_HEIGHT = 6;
const TILE_AREA_WIDTH = SCENE_WIDTH * TILE_SIZE; // 112 chars
const TILE_AREA_HEIGHT = SCENE_HEIGHT * CHAR_HEIGHT; // 48 rows

// Filler tile cache (for grass/trees above and below scene)
let fillerRowCache: Map<string, string[]> = new Map();

// Animation
const ANIMATION_INTERVAL = 250; // ms

// Debug log file (temporary, cleared each session)
const DEBUG_LOG_PATH = path.join(process.cwd(), '.claude', 'arbiter.tmp.log');

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

// Dialogue box tile indices (for message panels)
const DIALOGUE_TILES = {
  TOP_LEFT: 38,
  TOP_RIGHT: 39,
  BOTTOM_LEFT: 48,
  BOTTOM_RIGHT: 49,
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
function calculateInputLines(text: string, width: number): { displayLines: number; totalLines: number } {
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
    totalLines: Math.max(1, totalLines)
  };
}

function getLayout(inputText: string = '') {
  let width = 180;
  let height = 50;

  if (typeof term.width === 'number' && isFinite(term.width) && term.width > 0) {
    width = term.width;
  }
  if (typeof term.height === 'number' && isFinite(term.height) && term.height > 0) {
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

  // Input area at bottom, status bar above it, context bar above that, chat fills remaining space
  const inputY = height - inputLines + 1;  // +1 because 1-indexed
  const statusY = inputY - 1;
  const contextY = statusY - 1;  // Context bar above status
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
      y: statusY,
      width: chatAreaWidth,
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
    sceneState: {
      ...createInitialSceneState(),
      selectedCharacter: selectedCharacter ?? TILE.HUMAN_1,
      humanCol: 0, // Start at leftmost position for entry animation
      scrollVisible: !!appState.requirementsPath,
    },
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
    chatBubbleStartTime: 0,
    pendingExit: false,
    crashCount: 0,
    arbiterHasSpoken: false,
    // Requirements overlay state - always start as 'none', overlay triggered after entrance
    requirementsOverlay: 'none',
    requirementsFiles: [],
    requirementsFilteredFiles: [],
    requirementsSearchQuery: '',
    requirementsSelectedIndex: 0,
    requirementsCursorPos: 0,
    requirementsTilesDrawn: false,
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
  let inLogViewer = false; // Track when log viewer is open
  let inRequirementsOverlay = false; // Track when requirements overlay is open
  let entranceComplete = false; // Track if entrance animation is done
  let pendingArbiterMessage: string | null = null; // Message waiting for entrance to complete
  let arbiterWalkInterval: NodeJS.Timeout | null = null; // For walk animations

  // Track if we need to show requirements prompt after entrance
  const needsRequirementsPrompt = !appState.requirementsPath;

  // Summon sequence state machine
  // States: 'idle' (at human) → 'walking' (to cauldron) → 'ready' (can show demons) → 'dismissing' (walking back)
  type SummonState = 'idle' | 'walking' | 'ready' | 'dismissing';
  let summonState: SummonState = 'idle';
  let pendingDemonSpawns: number[] = []; // Queue of demon numbers waiting to appear

  // ============================================================================
  // Drawing Functions (Strategy 5 - Minimal Redraws)
  // ============================================================================

  /**
   * Get or create a cached filler row (grass with occasional trees)
   */
  function getFillerRow(tileset: Tileset, rowIndex: number): string[] {
    const cacheKey = `filler-${rowIndex}`;
    if (fillerRowCache.has(cacheKey)) {
      return fillerRowCache.get(cacheKey)!;
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
    if (inLogViewer || state.requirementsOverlay !== 'none') return;

    if (!state.tileset) return;
    const layout = getLayout(state.inputBuffer);

    // Draw filler rows above the scene (build from scene upward, so cut-off is at top edge)
    const rowsAbove = layout.tileArea.fillerRowsAbove;
    if (rowsAbove > 0) {
      const fillerTileRowsAbove = Math.ceil(rowsAbove / CHAR_HEIGHT);
      for (let tileRow = 0; tileRow < fillerTileRowsAbove; tileRow++) {
        const fillerLines = getFillerRow(state.tileset, tileRow);
        // Draw from bottom of this filler tile upward
        for (let charRow = CHAR_HEIGHT - 1; charRow >= 0; charRow--) {
          const screenY = layout.tileArea.y - 1 - (tileRow * CHAR_HEIGHT) - (CHAR_HEIGHT - 1 - charRow);
          if (screenY >= 1) {
            term.moveTo(layout.tileArea.x, screenY);
            process.stdout.write(fillerLines[charRow] + RESET);
          }
        }
      }
    }

    // Create scene from state
    const scene = createScene(state.sceneState);

    // Render scene to ANSI string (activeHops from sceneState, plus chat bubble)
    const sceneStr = renderScene(
      state.tileset,
      scene,
      state.sceneState.activeHops,
      state.sceneState
    );

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
          const screenY = layout.tileArea.y + TILE_AREA_HEIGHT + (tileRow * CHAR_HEIGHT) + charRow;
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
      renderedLines.push({ text: `${waiting} is working${dots}`, color: `\x1b[2m${indicatorColor}` });
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
    if (inLogViewer || state.requirementsOverlay !== 'none') return;

    const scrollChanged = state.scrollOffset !== tracker.lastScrollOffset;
    const messagesChanged = state.messages.length !== tracker.lastMessageCount;
    const waitingChanged = state.waitingFor !== tracker.lastChatWaitingFor;
    // Only track blink cycle changes when waiting (for slower blinking effect)
    const blinkChanged =
      state.waitingFor !== 'none' &&
      state.blinkCycle !== tracker.lastChatAnimFrame;
    // Track tool indicator changes
    const toolIndicatorChanged =
      state.showToolIndicator !== tracker.lastShowToolIndicator ||
      state.toolCountSinceLastMessage !== tracker.lastToolCount;

    if (!force && !scrollChanged && !messagesChanged && !waitingChanged && !blinkChanged && !toolIndicatorChanged) return;

    tracker.lastScrollOffset = state.scrollOffset;
    tracker.lastMessageCount = state.messages.length;
    tracker.lastChatWaitingFor = state.waitingFor;
    tracker.lastShowToolIndicator = state.showToolIndicator;
    tracker.lastToolCount = state.toolCountSinceLastMessage;
    tracker.lastChatAnimFrame = state.blinkCycle;

    const layout = getLayout(state.inputBuffer);
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
    if (inLogViewer || state.requirementsOverlay !== 'none') return;

    const contextChanged =
      state.arbiterContextPercent !== tracker.lastContextPercent ||
      state.orchestratorContextPercent !== tracker.lastOrchestratorPercent;

    if (!force && !contextChanged) return;

    // Update trackers
    tracker.lastContextPercent = state.arbiterContextPercent;
    tracker.lastOrchestratorPercent = state.orchestratorContextPercent;

    const layout = getLayout(state.inputBuffer);
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
   * Draw status bar - only redraws if mode changed
   * Shows mode indicator and keyboard hints only (context info is on separate line above)
   */
  function drawStatus(force: boolean = false) {
    // Skip drawing if log viewer or requirements overlay is open
    if (inLogViewer || state.requirementsOverlay !== 'none') return;

    const modeChanged = state.mode !== tracker.lastMode;

    if (!force && !modeChanged) return;

    const layout = getLayout(state.inputBuffer);
    const statusX = layout.statusBar.x;
    const statusY = layout.statusBar.y;

    // Clear the status line (only chat area width, not the tile scene)
    term.moveTo(statusX, statusY);
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
      term.moveTo(statusX, statusY);
      process.stdout.write(exitPrompt);
      return;
    }

    // Build status line (mode + hints only - context info is now on separate line)
    let statusLine = '';

    if (state.mode === 'INSERT') {
      statusLine += '\x1b[42;30m INSERT \x1b[0m'; // Green bg, black text
      statusLine += '\x1b[38;2;140;140;140m    esc:scroll  ·  \\+enter:newline  ·  ^C:quit  ·  ^Z:suspend \x1b[0m';
    } else {
      statusLine += '\x1b[48;2;130;44;19m\x1b[97m SCROLL \x1b[0m'; // Brown bg (130,44,19), bright white text
      statusLine += '\x1b[38;2;140;140;140m    i:insert  ·  ↑/↓:scroll  ·  o:log  ·  ^C:quit  ·  ^Z:suspend \x1b[0m';
    }

    term.moveTo(statusX, statusY);
    process.stdout.write(statusLine);
  }

  /**
   * Draw input area - only redraws if input changed
   * Now supports multi-line input (1-5 lines based on content)
   */
  function drawInput(force: boolean = false) {
    const layout = getLayout(state.inputBuffer);
    const inputHeight = layout.inputArea.height;

    const inputChanged = state.inputBuffer !== tracker.lastInputBuffer ||
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
            break outer;
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
            break outer;
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

  /**
   * Full redraw of all components
   */
  function fullDraw() {
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
    if (state.requirementsOverlay !== 'none') {
      drawRequirementsOverlay();
    } else {
      drawTiles(true);
      drawChat(true);
      drawContext(true);
      drawStatus(true);
      drawInput(true);
    }
  }

  // ============================================================================
  // Requirements Overlay Functions
  // ============================================================================

  /**
   * Draw the requirements overlay based on current state
   */
  function drawRequirementsOverlay(): void {
    if (!state.tileset) return;

    // Draw the scene (left side) only if not already drawn - avoids flicker on keystroke
    if (!state.requirementsTilesDrawn) {
      drawTilesInternal();
      state.requirementsTilesDrawn = true;
    }

    let panelLines: string[] = [];
    let panelWidth = 6; // tiles

    switch (state.requirementsOverlay) {
      case 'prompt':
        panelLines = renderMessagePanel(state.tileset, [
          '\x1b[97mDo you bring a Scroll of Requirements?\x1b[0m',
          '\x1b[90m(a detailed markdown file describing your task)\x1b[0m',
          '',
          '\x1b[90mThe Arbiter rewards those who come prepared.\x1b[0m',
          '\x1b[90mScrolls contain context, specs, and acceptance criteria.\x1b[0m',
          '',
          '\x1b[92m[Y]\x1b[0m Yes, I have a .md file    \x1b[91m[N]\x1b[0m No, I\'ll wing it',
        ], panelWidth);
        break;

      case 'picker':
        // Build file list display with cursor at correct position
        const beforeCursor = state.requirementsSearchQuery.slice(0, state.requirementsCursorPos);
        const afterCursor = state.requirementsSearchQuery.slice(state.requirementsCursorPos);
        const inputLineWithCursor = `\x1b[90m> ${beforeCursor}\x1b[97m_\x1b[90m${afterCursor}\x1b[0m`;

        const displayLines: string[] = [
          '\x1b[97mSelect your Scroll of Requirements:\x1b[0m',
          '\x1b[90m(markdown files in your project)\x1b[0m',
          '',
          inputLineWithCursor,
          '',
        ];

        // Show filtered files (max 16 for 3-tile tall panel)
        const files = state.requirementsFilteredFiles.length > 0
          ? state.requirementsFilteredFiles
          : state.requirementsFiles;
        const maxVisible = 16;
        const startIdx = Math.max(0, state.requirementsSelectedIndex - Math.floor(maxVisible / 2));
        const visibleFiles = files.slice(startIdx, startIdx + maxVisible);

        visibleFiles.forEach((file, i) => {
          const actualIdx = startIdx + i;
          const isSelected = actualIdx === state.requirementsSelectedIndex;
          const prefix = isSelected ? '\x1b[93m> ' : '  ';
          const suffix = isSelected ? '\x1b[0m' : '';
          displayLines.push(`${prefix}${file}${suffix}`);
        });

        if (files.length === 0) {
          displayLines.push('\x1b[90m(no .md files found - the scroll rack is empty)\x1b[0m');
        }

        displayLines.push('');
        displayLines.push('\x1b[90mArrow keys navigate  Enter select  Esc to flee\x1b[0m');

        panelWidth = 7;
        panelLines = renderMessagePanel(state.tileset, displayLines, panelWidth, 3);
        break;

      case 'rat-transform':
        panelLines = renderMessagePanel(state.tileset, [
          '\x1b[91mYou have been transformed into a rat.\x1b[0m',
          '\x1b[90m(the Arbiter does not suffer the unprepared)\x1b[0m',
          '',
          '\x1b[90mCome back with a requirements.md or similar.\x1b[0m',
          '',
          '\x1b[90mPress any key to scurry away...\x1b[0m',
        ], 5);
        break;

      default:
        return;
    }

    // Position the panel within the SCENE area only (not whole screen)
    // Scene dimensions: 7 tiles x 6 tiles = 112 chars x 48 rows
    const sceneWidthChars = 7 * 16;  // 112
    const sceneHeightChars = 6 * 8;  // 48

    const panelWidthChars = panelWidth * 16;
    const panelHeight = panelLines.length;

    // Center panel within scene area
    const panelX = Math.max(1, Math.floor((sceneWidthChars - panelWidthChars) / 2));

    // For rat-transform, position at bottom of scene, shifted one tile right; for others, center vertically in scene
    let panelY: number;
    let finalPanelX = panelX;
    if (state.requirementsOverlay === 'rat-transform') {
      panelY = sceneHeightChars - panelHeight + 4;  // Lower position so arbiter at row 3 is visible
      finalPanelX = panelX + 16;  // One tile to the right
    } else {
      panelY = Math.max(1, Math.floor((sceneHeightChars - panelHeight) / 2));
    }

    // Draw panel
    for (let i = 0; i < panelLines.length; i++) {
      term.moveTo(finalPanelX, panelY + i);
      process.stdout.write(panelLines[i] + RESET);
    }
  }

  /**
   * Redraw just the picker input line (for cursor movement)
   * Falls back to full panel redraw for simplicity, but structured for future optimization
   */
  function drawPickerInput(): void {
    // For now, redraw the full panel (but not the tiles)
    drawRequirementsOverlay();
  }

  /**
   * Redraw the picker file list only
   * Falls back to full panel redraw for simplicity, but structured for future optimization
   */
  function drawPickerList(): void {
    // For now, redraw the full panel (but not the tiles)
    drawRequirementsOverlay();
  }

  /**
   * Redraw picker content (input + list) without full panel redraw
   * Falls back to full panel redraw for simplicity, but structured for future optimization
   */
  function drawPickerContent(): void {
    // For now, redraw the full panel (but not the tiles)
    drawRequirementsOverlay();
  }

  /**
   * Internal tile drawing (used by overlay to draw scene behind)
   * This is a simplified version that doesn't check overlay state
   */
  function drawTilesInternal(): void {
    if (!state.tileset) return;
    const layout = getLayout(state.inputBuffer);

    // Draw filler rows above the scene
    const rowsAbove = layout.tileArea.fillerRowsAbove;
    if (rowsAbove > 0) {
      const fillerTileRowsAbove = Math.ceil(rowsAbove / CHAR_HEIGHT);
      for (let tileRow = 0; tileRow < fillerTileRowsAbove; tileRow++) {
        const fillerLines = getFillerRow(state.tileset, tileRow);
        for (let charRow = CHAR_HEIGHT - 1; charRow >= 0; charRow--) {
          const screenY = layout.tileArea.y - 1 - (tileRow * CHAR_HEIGHT) - (CHAR_HEIGHT - 1 - charRow);
          if (screenY >= 1) {
            term.moveTo(layout.tileArea.x, screenY);
            process.stdout.write(fillerLines[charRow] + RESET);
          }
        }
      }
    }

    // Create scene from state
    const scene = createScene(state.sceneState);

    // Render scene to ANSI string
    const sceneStr = renderScene(
      state.tileset,
      scene,
      state.sceneState.activeHops,
      state.sceneState
    );

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
          const screenY = layout.tileArea.y + TILE_AREA_HEIGHT + (tileRow * CHAR_HEIGHT) + charRow;
          if (screenY <= layout.height) {
            term.moveTo(layout.tileArea.x, screenY);
            process.stdout.write(fillerLines[charRow] + RESET);
          }
        }
      }
    }
  }

  /**
   * Key handler for requirements overlay
   */
  function requirementsKeyHandler(key: string): void {
    switch (state.requirementsOverlay) {
      case 'prompt':
        if (key === 'y' || key === 'Y') {
          // Switch to file picker
          loadFilesForPicker();
          state.requirementsOverlay = 'picker';
          inRequirementsOverlay = true;
          drawRequirementsOverlay();
        } else if (key === 'n' || key === 'N') {
          // Rat transformation
          playSfx('magic');
          // First show smoke
          state.sceneState.selectedCharacter = TILE.SMOKE; // 90
          state.requirementsTilesDrawn = false;  // Reset so tiles get redrawn with smoke
          drawTilesInternal();
          state.requirementsTilesDrawn = true;  // Mark as drawn

          // After 1500ms (3x longer smoke animation), show rat
          setTimeout(() => {
            state.sceneState.selectedCharacter = 210; // Rat tile
            state.requirementsOverlay = 'rat-transform';
            state.requirementsTilesDrawn = false;  // Reset so tiles get redrawn with rat
            drawRequirementsOverlay();
          }, 1500);
        }
        break;

      case 'picker':
        if (key === 'UP') {
          state.requirementsSelectedIndex = Math.max(0, state.requirementsSelectedIndex - 1);
          drawPickerList();
        } else if (key === 'DOWN') {
          const files = state.requirementsFilteredFiles.length > 0
            ? state.requirementsFilteredFiles
            : state.requirementsFiles;
          state.requirementsSelectedIndex = Math.min(files.length - 1, state.requirementsSelectedIndex + 1);
          drawPickerList();
        } else if (key === 'LEFT') {
          // Move cursor left in search query
          state.requirementsCursorPos = Math.max(0, state.requirementsCursorPos - 1);
          drawPickerInput();
        } else if (key === 'RIGHT') {
          // Move cursor right in search query
          state.requirementsCursorPos = Math.min(state.requirementsSearchQuery.length, state.requirementsCursorPos + 1);
          drawPickerInput();
        } else if (key === 'ENTER') {
          // Select file
          const files = state.requirementsFilteredFiles.length > 0
            ? state.requirementsFilteredFiles
            : state.requirementsFiles;
          if (files.length > 0) {
            const selectedFile = files[state.requirementsSelectedIndex];
            selectRequirementsFile(selectedFile);
          }
        } else if (key === 'ESCAPE') {
          // Cancel - go back to prompt
          state.requirementsOverlay = 'prompt';
          state.requirementsSearchQuery = '';
          state.requirementsSelectedIndex = 0;
          state.requirementsCursorPos = 0;
          state.requirementsTilesDrawn = false;  // Force scene redraw to clear larger picker
          drawRequirementsOverlay();
        } else if (key === 'BACKSPACE') {
          // Delete char before cursor
          if (state.requirementsCursorPos > 0) {
            state.requirementsSearchQuery =
              state.requirementsSearchQuery.slice(0, state.requirementsCursorPos - 1) +
              state.requirementsSearchQuery.slice(state.requirementsCursorPos);
            state.requirementsCursorPos--;
            filterFiles();
            drawPickerContent();
          }
        } else if (key.length === 1 && key.match(/[a-zA-Z0-9._\-\/]/)) {
          // Insert char at cursor position
          state.requirementsSearchQuery =
            state.requirementsSearchQuery.slice(0, state.requirementsCursorPos) +
            key +
            state.requirementsSearchQuery.slice(state.requirementsCursorPos);
          state.requirementsCursorPos++;
          filterFiles();
          drawPickerContent();
        }
        break;

      case 'rat-transform':
        // Any key exits
        process.exit(0);
        break;
    }
  }

  /**
   * Load files for the picker using recursive directory walk
   */
  function loadFilesForPicker(): void {
    const files: string[] = [];

    function walkDir(dir: string, prefix: string = ''): void {
      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          if (entry.startsWith('.') || entry === 'node_modules') continue;
          const fullPath = path.join(dir, entry);
          const relativePath = prefix ? `${prefix}/${entry}` : entry;
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              walkDir(fullPath, relativePath);
            } else if (entry.endsWith('.md')) {
              files.push(relativePath);
            }
          } catch {
            // Skip files we can't stat
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }

    walkDir(process.cwd());
    state.requirementsFiles = files;
    state.requirementsFilteredFiles = files;
  }

  /**
   * Filter files using fzf algorithm
   */
  function filterFiles(): void {
    if (!state.requirementsSearchQuery) {
      state.requirementsFilteredFiles = state.requirementsFiles;
      state.requirementsSelectedIndex = 0;
      return;
    }

    const fzf = new Fzf(state.requirementsFiles);
    const results = fzf.find(state.requirementsSearchQuery);
    state.requirementsFilteredFiles = results.map((r: { item: string }) => r.item);
    state.requirementsSelectedIndex = 0;
  }

  /**
   * Select a requirements file and close overlay
   */
  function selectRequirementsFile(filePath: string): void {
    appState.requirementsPath = filePath;
    state.sceneState.scrollVisible = true;
    state.requirementsOverlay = 'none';
    state.requirementsTilesDrawn = false;  // Reset for next time overlay is shown
    inRequirementsOverlay = false;
    fullDraw();

    // Signal that requirements are ready (router can start now)
    if (requirementsReadyCallback) {
      requirementsReadyCallback();
      requirementsReadyCallback = null;
    }

    // NOW trigger arbiter walk (was waiting for requirements selection)
    startArbiterWalk();
  }

  // ============================================================================
  // Helper Functions
  // ============================================================================

  /**
   * Strip ANSI escape codes from a string to get visible length
   */
  function stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }

  /**
   * Create middle fill row for dialogue box (samples from left tile's middle column)
   */
  function createMiddleFill(leftTile: RGB[][], charRow: number): string {
    const pixelRowTop = charRow * 2;
    const pixelRowBot = pixelRowTop + 1;
    const sampleX = 8; // Middle column

    let result = '';
    for (let x = 0; x < 16; x++) {
      const topPixel = leftTile[pixelRowTop][sampleX];
      const botPixel = leftTile[pixelRowBot]?.[sampleX] || topPixel;
      result += `\x1b[48;2;${topPixel.r};${topPixel.g};${topPixel.b}m`;
      result += `\x1b[38;2;${botPixel.r};${botPixel.g};${botPixel.b}m`;
      result += '\u2584';
    }
    result += RESET;
    return result;
  }

  /**
   * Wrap text with consistent background color
   */
  function wrapTextWithBg(text: string, bgColor: string): string {
    const bgMaintained = text.replace(/\x1b\[0m/g, `\x1b[0m${bgColor}`);
    return bgColor + bgMaintained + RESET;
  }

  /**
   * Create middle row border segments for panels taller than 2 tiles.
   *
   * For panels with heightTiles > 2, we need "middle" tile rows that only have
   * left and right vertical borders (no top/bottom horizontal borders). This function
   * generates the ANSI strings for those vertical borders by sampling from the
   * BOTTOM HALF of the top corner tiles (38, 39), which contain just the vertical
   * border lines without the horizontal top border.
   *
   * The pattern from the bottom half of the tiles is repeated for all 8 character
   * rows of each middle tile row using modulo 4 (since bottom half = 4 char rows).
   *
   * @param tileset - The loaded tileset containing dialogue corner tiles
   * @param charRow - Which character row within the tile (0-7)
   * @returns Object containing:
   *   - left: 16-char wide left border segment (ANSI string)
   *   - fill: 16-char wide interior fill segment (solid background color)
   *   - right: 16-char wide right border segment (ANSI string)
   *
   * @internal Used by renderMessagePanel() for heightTiles > 2
   */
  function createMiddleRowBorders(tileset: Tileset, charRow: number): { left: string; fill: string; right: string } {
    // Use the BOTTOM HALF of the top corner tiles for middle rows
    // This gives us just the vertical border without horizontal border lines
    const topLeftTile = extractTile(tileset, DIALOGUE_TILES.TOP_LEFT);
    const topRightTile = extractTile(tileset, DIALOGUE_TILES.TOP_RIGHT);

    // For middle rows, we render from the bottom half of the top tiles
    // Bottom half of tile is pixel rows 8-15 (4 char rows worth)
    // Use modulo to repeat this pattern for all 8 char rows
    const actualCharRow = charRow % 4;
    const pixelRowTop = 8 + (actualCharRow * 2);  // Start from row 8 (bottom half)
    const pixelRowBot = pixelRowTop + 1;

    // Render left border (full 16 chars from bottom half of top-left tile)
    let left = '';
    for (let x = 0; x < 16; x++) {
      const topPixel = topLeftTile[pixelRowTop][x];
      const botPixel = topLeftTile[pixelRowBot]?.[x] || topPixel;
      left += `\x1b[48;2;${topPixel.r};${topPixel.g};${topPixel.b}m`;
      left += `\x1b[38;2;${botPixel.r};${botPixel.g};${botPixel.b}m`;
      left += '\u2584';
    }
    left += RESET;

    // Render right border (full 16 chars from bottom half of top-right tile)
    let right = '';
    for (let x = 0; x < 16; x++) {
      const topPixel = topRightTile[pixelRowTop][x];
      const botPixel = topRightTile[pixelRowBot]?.[x] || topPixel;
      right += `\x1b[48;2;${topPixel.r};${topPixel.g};${topPixel.b}m`;
      right += `\x1b[38;2;${botPixel.r};${botPixel.g};${botPixel.b}m`;
      right += '\u2584';
    }
    right += RESET;

    // For fill, sample the interior color from center of tile
    const sampleX = 8;
    const topPixel = topLeftTile[pixelRowTop][sampleX];
    const botPixel = topLeftTile[pixelRowBot]?.[sampleX] || topPixel;
    let fill = '';
    for (let x = 0; x < 16; x++) {
      fill += `\x1b[48;2;${topPixel.r};${topPixel.g};${topPixel.b}m`;
      fill += `\x1b[38;2;${botPixel.r};${botPixel.g};${botPixel.b}m`;
      fill += '\u2584';
    }
    fill += RESET;

    return { left, fill, right };
  }

  /**
   * Render a tile-bordered message panel with customizable dimensions.
   *
   * Creates a decorative RPG-style panel using dialogue box corner tiles from the
   * Jerom Fantasy Tileset. The panel consists of:
   * - Corner tiles (38=top-left, 39=top-right, 48=bottom-left, 49=bottom-right)
   * - Horizontal fill segments between corners (sampled from corner tile interiors)
   * - Vertical border segments for middle rows (panels taller than 2 tiles)
   *
   * Text is automatically centered both horizontally and vertically within the
   * interior area. ANSI color codes in textLines are preserved and handled correctly.
   * Long lines are truncated with "..." if they exceed the interior width.
   *
   * ## Panel Structure
   *
   * For a 5-wide x 3-tall panel:
   * ```
   * [TL][fill][fill][fill][TR]   <- Top row of tiles (8 char rows)
   * [L ][    interior    ][R ]   <- Middle row(s) (8 char rows each)
   * [BL][fill][fill][fill][BR]   <- Bottom row of tiles (8 char rows)
   * ```
   *
   * ## Dimensions Reference
   *
   * - Each tile = 16 characters wide x 8 character rows tall
   * - Interior width = (widthTiles - 2) * 16 characters
   * - Total height = heightTiles * 8 character rows
   * - Usable text area excludes ~2 rows at top and bottom for borders
   *
   * @param tileset - The loaded tileset containing dialogue tiles (38, 39, 48, 49)
   * @param textLines - Array of text lines to display. Can include ANSI color codes.
   *                    Lines exceeding interior width are truncated with "..."
   * @param widthTiles - Panel width in tiles (default 5). Minimum 2 (corners only).
   *                     Each tile adds 16 characters of width.
   *                     - 4 tiles = 64 chars (48 interior)
   *                     - 5 tiles = 80 chars (48 interior)
   *                     - 6 tiles = 96 chars (64 interior)
   * @param heightTiles - Panel height in tiles (default 2). Minimum 2 (top + bottom row).
   *                      Each tile adds 8 character rows.
   *                      - 2 tiles = 16 rows (~12 usable for text)
   *                      - 3 tiles = 24 rows (~20 usable for text)
   *                      - 4 tiles = 32 rows (~28 usable for text)
   * @returns Array of ANSI strings, one per character row (length = heightTiles * 8)
   *
   * @example
   * // Small 2-tile high prompt (16 char rows, fits ~3-4 lines of text)
   * const panel = renderMessagePanel(tileset, ['Hello!', 'Press any key...'], 4, 2);
   *
   * @example
   * // Taller 3-tile panel for file picker or multi-line content (24 char rows)
   * const fileList = ['config.json', 'index.ts', 'package.json', 'README.md'];
   * const panel = renderMessagePanel(tileset, fileList, 6, 3);
   *
   * @example
   * // Wide panel for longer text lines
   * const panel = renderMessagePanel(tileset, ['A much longer line of text here'], 7, 2);
   *
   * @example
   * // Extra tall 4-tile panel for extensive content (32 char rows)
   * const panel = renderMessagePanel(tileset, longContentArray, 5, 4);
   *
   * @example
   * // Text with ANSI colors (colors are preserved)
   * const coloredLines = [
   *   '\x1b[33mWarning:\x1b[0m File not found',
   *   '\x1b[32mSuccess:\x1b[0m Operation complete'
   * ];
   * const panel = renderMessagePanel(tileset, coloredLines, 5, 2);
   */
  function renderMessagePanel(tileset: Tileset, textLines: string[], widthTiles: number = 5, heightTiles: number = 2): string[] {
    const topLeft = extractTile(tileset, DIALOGUE_TILES.TOP_LEFT);
    const topRight = extractTile(tileset, DIALOGUE_TILES.TOP_RIGHT);
    const bottomLeft = extractTile(tileset, DIALOGUE_TILES.BOTTOM_LEFT);
    const bottomRight = extractTile(tileset, DIALOGUE_TILES.BOTTOM_RIGHT);

    const tlRendered = renderTile(topLeft);
    const trRendered = renderTile(topRight);
    const blRendered = renderTile(bottomLeft);
    const brRendered = renderTile(bottomRight);

    // Create middle fill rows for top and bottom tiles
    const middleTopRendered: string[] = [];
    const middleBottomRendered: string[] = [];
    for (let row = 0; row < CHAR_HEIGHT; row++) {
      middleTopRendered.push(createMiddleFill(topLeft, row));
      middleBottomRendered.push(createMiddleFill(bottomLeft, row));
    }

    // Create middle row borders (for panels taller than 2 tiles)
    const middleRowBorders: { left: string; fill: string; right: string }[] = [];
    for (let row = 0; row < CHAR_HEIGHT; row++) {
      middleRowBorders.push(createMiddleRowBorders(tileset, row));
    }

    const middleTiles = Math.max(0, widthTiles - 2);
    const interiorWidth = middleTiles * 16;
    const middleRows = Math.max(0, heightTiles - 2); // Number of middle tile rows

    // Sample background color from tile center
    const bgSamplePixel = topLeft[8][8];
    const textBgColor = `\x1b[48;2;${bgSamplePixel.r};${bgSamplePixel.g};${bgSamplePixel.b}m`;

    const boxLines: string[] = [];

    // Top row of tiles
    for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
      let line = tlRendered[charRow];
      for (let m = 0; m < middleTiles; m++) {
        line += middleTopRendered[charRow];
      }
      line += trRendered[charRow];
      boxLines.push(line);
    }

    // Middle rows of tiles (for height > 2)
    for (let middleRowIdx = 0; middleRowIdx < middleRows; middleRowIdx++) {
      for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
        const borders = middleRowBorders[charRow];
        let line = borders.left;
        for (let m = 0; m < middleTiles; m++) {
          line += borders.fill;
        }
        line += borders.right;
        boxLines.push(line);
      }
    }

    // Bottom row of tiles
    for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
      let line = blRendered[charRow];
      for (let m = 0; m < middleTiles; m++) {
        line += middleBottomRendered[charRow];
      }
      line += brRendered[charRow];
      boxLines.push(line);
    }

    // Center text in the interior area only (excluding top and bottom tile rows for panels > 2 tiles)
    const boxHeight = CHAR_HEIGHT * heightTiles;

    // Calculate interior area where text can be placed
    let interiorStartRow: number;
    let interiorEndRow: number;

    if (heightTiles <= 2) {
      // For 2-tile panels: text can go in rows 4-11 (lower half of top tile, upper half of bottom tile)
      interiorStartRow = 2;
      interiorEndRow = boxHeight - 3;
    } else {
      // For 3+ tile panels: text can go in rows 2 through boxHeight-3
      // This allows text in top tile (rows 2-7), middle tiles (all rows), and bottom tile (rows 0-5)
      interiorStartRow = 2;  // Leave 2 rows for top border
      interiorEndRow = boxHeight - 3;  // Leave 2 rows for bottom border
    }

    const interiorHeight = interiorEndRow - interiorStartRow + 1;
    const textStartOffset = interiorStartRow + Math.floor((interiorHeight - textLines.length) / 2);

    for (let i = 0; i < textLines.length; i++) {
      const boxLineIndex = textStartOffset + i;
      // Only write text to rows within the interior area
      if (boxLineIndex >= interiorStartRow && boxLineIndex <= interiorEndRow && boxLineIndex < boxLines.length) {
        let line = textLines[i];
        let visibleLength = stripAnsi(line).length;

        // Truncate text if it exceeds interior width
        if (visibleLength > interiorWidth) {
          // Simple truncation - remove characters from the end
          // This handles ANSI codes by checking visible length
          let truncated = '';
          let truncatedVisible = 0;
          const maxLen = interiorWidth - 3; // Leave room for "..."
          for (let c = 0; c < line.length && truncatedVisible < maxLen; c++) {
            truncated += line[c];
            // Check if this added to visible length
            const newVisibleLen = stripAnsi(truncated).length;
            truncatedVisible = newVisibleLen;
          }
          line = truncated + '...';
          visibleLength = stripAnsi(line).length;
        }

        const padding = Math.max(0, Math.floor((interiorWidth - visibleLength) / 2));
        const rightPadding = Math.max(0, interiorWidth - padding - visibleLength);
        const textContent = ' '.repeat(padding) + line + ' '.repeat(rightPadding);
        const textWithBg = wrapTextWithBg(textContent, textBgColor);

        // Determine which tile row we're in and the char row within that tile
        const tileRowIdx = Math.floor(boxLineIndex / CHAR_HEIGHT);
        const charRow = boxLineIndex % CHAR_HEIGHT;

        // Get appropriate left/right borders based on tile row
        let leftBorder: string;
        let rightBorder: string;
        if (tileRowIdx === 0) {
          // Top tile row
          leftBorder = tlRendered[charRow];
          rightBorder = trRendered[charRow];
        } else if (tileRowIdx === heightTiles - 1) {
          // Bottom tile row
          leftBorder = blRendered[charRow];
          rightBorder = brRendered[charRow];
        } else {
          // Middle tile row
          const borders = middleRowBorders[charRow];
          leftBorder = borders.left;
          rightBorder = borders.right;
        }

        boxLines[boxLineIndex] = leftBorder + textWithBg + rightBorder;
      }
    }

    return boxLines;
  }

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

    // Set chat bubble for the speaker (clears any previous bubble)
    if (speaker === 'human') {
      state.sceneState.chatBubbleTarget = 'human';
      state.chatBubbleStartTime = Date.now();
    } else if (speaker === 'arbiter') {
      state.sceneState.chatBubbleTarget = 'arbiter';
      state.chatBubbleStartTime = Date.now();
    } else if (speaker === 'orchestrator') {
      state.sceneState.chatBubbleTarget = 'conjuring';
      state.chatBubbleStartTime = Date.now();
    }
    // system messages don't show a chat bubble

    // Auto-scroll to bottom using single source of truth
    const layout = getLayout(state.inputBuffer);
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
  function getCursorLineCol(text: string, cursorPos: number, lineWidth: number): { line: number; col: number; totalLines: number } {
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
            return { line: lineIndex, col: cursorPos - lineStart, totalLines: countTotalLines(text, lineWidth) };
          }
          // Cursor at end of this wrapped segment (and it's the last segment of paragraph)
          if (cursorPos === lineEnd && i + lineWidth >= para.length) {
            return { line: lineIndex, col: cursorPos - lineStart, totalLines: countTotalLines(text, lineWidth) };
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
    return { line: lineIndex - 1, col: text.length - charIndex + (paragraphs[paragraphs.length - 1]?.length || 0), totalLines: countTotalLines(text, lineWidth) };
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
  function lineToCursorPos(text: string, targetLine: number, targetCol: number, lineWidth: number): number {
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
        const layout = getLayout(state.inputBuffer);
        const textWidth = layout.inputArea.width - 3; // Match drawInput calculation
        const { line, col, totalLines } = getCursorLineCol(state.inputBuffer, state.cursorPos, textWidth);

        if (line > 0) {
          // Move to previous line, same column (or end if shorter)
          state.cursorPos = lineToCursorPos(state.inputBuffer, line - 1, col, textWidth);
          drawInput();
        }
        break;
      }

      case 'DOWN': {
        const layout = getLayout(state.inputBuffer);
        const textWidth = layout.inputArea.width - 3;
        const { line, col, totalLines } = getCursorLineCol(state.inputBuffer, state.cursorPos, textWidth);

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
      case 'ENTER':
        state.mode = 'INSERT';
        // Auto-scroll to bottom when entering insert mode
        const layoutIns = getLayout(state.inputBuffer);
        const renderedLinesIns = getRenderedChatLines(layoutIns.chatArea.width);
        state.scrollOffset = Math.max(0, renderedLinesIns.length - layoutIns.chatArea.height);
        drawChat();
        drawStatus(true);
        drawInput(true);
        break;

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

      case 'G':
        // Scroll to bottom using single source of truth
        const layoutG = getLayout(state.inputBuffer);
        const renderedLinesG = getRenderedChatLines(layoutG.chatArea.width);
        state.scrollOffset = Math.max(0, renderedLinesG.length - layoutG.chatArea.height);
        drawChat();
        break;

      case 'o':
        // Open debug log with less
        openLogViewer();
        break;

      default:
        break;
    }
  }

  /**
   * Opens a simple built-in log viewer (avoids signal handling issues with less)
   */
  function openLogViewer() {
    // Check if log file exists
    if (!fs.existsSync(DEBUG_LOG_PATH)) {
      return;
    }

    inLogViewer = true;

    // Read the log file
    let logContent: string;
    try {
      logContent = fs.readFileSync(DEBUG_LOG_PATH, 'utf-8');
    } catch (err) {
      inLogViewer = false;
      return;
    }

    const logLines = logContent.split('\n');
    let logScrollOffset = Math.max(0, logLines.length - (term.height - 2)); // Start at bottom

    function drawLogViewer() {
      term.clear();
      const visibleLines = term.height - 2; // Leave room for header and footer

      // Header - green like INSERT mode
      term.moveTo(1, 1);
      process.stdout.write('\x1b[42;30m DEBUG LOG \x1b[0m');
      process.stdout.write(`\x1b[2m (${logLines.length} lines, showing ${logScrollOffset + 1}-${Math.min(logScrollOffset + visibleLines, logLines.length)})\x1b[0m`);

      // Log content
      for (let i = 0; i < visibleLines; i++) {
        const lineIdx = logScrollOffset + i;
        term.moveTo(1, i + 2);
        term.eraseLine();
        if (lineIdx < logLines.length) {
          // Truncate long lines and display with default colors
          const line = logLines[lineIdx].substring(0, term.width - 1);
          process.stdout.write('\x1b[0m' + line);
        }
      }

      // Footer - green like INSERT mode
      term.moveTo(1, term.height);
      process.stdout.write('\x1b[42;30m j/k:line  u/d:half  b/f:page  g/G:top/bottom  q:close  ^C:quit  ^Z:suspend \x1b[0m');
    }

    drawLogViewer();

    // Handle log viewer keys
    // (animation keeps running in background so state stays current)
    const logKeyHandler = (key: string) => {
      if (key === 'q' || key === 'ESCAPE') {
        // Close log viewer
        term.off('key', logKeyHandler);
        inLogViewer = false;
        fullDraw();
        return;
      }

      if (key === 'CTRL_C') {
        // Close log viewer and show exit prompt
        term.off('key', logKeyHandler);
        inLogViewer = false;
        fullDraw();
        state.pendingExit = true;
        drawStatus(true);
        return;
      }

      if (key === 'CTRL_Z') {
        // Close log viewer and suspend
        term.off('key', logKeyHandler);
        inLogViewer = false;
        if (process.stdin.isTTY && process.stdin.setRawMode) {
          process.stdin.setRawMode(false);
        }
        process.removeAllListeners('SIGTSTP');
        process.kill(0, 'SIGTSTP');
        return;
      }
      // Note: CTRL_BACKSLASH is handled via raw stdin listener in start()

      const visibleLines = term.height - 2;
      const halfPage = Math.floor(visibleLines / 2);
      const maxScroll = Math.max(0, logLines.length - visibleLines);

      if (key === 'j' || key === 'DOWN') {
        logScrollOffset = Math.min(maxScroll, logScrollOffset + 1);
        drawLogViewer();
      } else if (key === 'k' || key === 'UP') {
        logScrollOffset = Math.max(0, logScrollOffset - 1);
        drawLogViewer();
      } else if (key === 'g') {
        logScrollOffset = 0;
        drawLogViewer();
      } else if (key === 'G') {
        logScrollOffset = maxScroll;
        drawLogViewer();
      } else if (key === 'u') {
        // Half page up
        logScrollOffset = Math.max(0, logScrollOffset - halfPage);
        drawLogViewer();
      } else if (key === 'd') {
        // Half page down
        logScrollOffset = Math.min(maxScroll, logScrollOffset + halfPage);
        drawLogViewer();
      } else if (key === 'b' || key === 'PAGE_UP') {
        // Full page up
        logScrollOffset = Math.max(0, logScrollOffset - visibleLines);
        drawLogViewer();
      } else if (key === 'f' || key === 'PAGE_DOWN') {
        // Full page down
        logScrollOffset = Math.min(maxScroll, logScrollOffset + visibleLines);
        drawLogViewer();
      }
    };

    term.on('key', logKeyHandler);
  }

  // ============================================================================
  // Animation
  // ============================================================================

  /**
   * Get the current position (row, col) of a character type
   */
  function getCharacterPosition(target: 'human' | 'arbiter' | 'conjuring'): { row: number; col: number } {
    if (target === 'human') {
      return { row: 2, col: state.sceneState.humanCol };
    } else if (target === 'arbiter') {
      // Map arbiterPos to actual row/col
      const pos = state.sceneState.arbiterPos;
      switch (pos) {
        case 0: return { row: 2, col: 2 };
        case 1: return { row: 2, col: 3 };
        case 2: return { row: 2, col: 4 };
        case 3: return { row: 3, col: 4 };
        default: return { row: 2, col: 3 }; // fallback
      }
    } else {
      // conjuring = first demon at row 2, col 6
      return { row: 2, col: 6 };
    }
  }

  /**
   * Trigger a hop animation at a specific position
   * @param row Tile row
   * @param col Tile column
   * @param count Number of hops (default 1)
   */
  function triggerHop(row: number, col: number, count: number = 1) {
    const key = `${row},${col}`;
    state.sceneState.activeHops.set(key, {
      remaining: count,
      frameInHop: 0, // Start in "up" position
    });
    drawTiles(true);
  }

  /**
   * Trigger hop by character name (convenience wrapper)
   */
  function triggerCharacterHop(target: 'human' | 'arbiter' | 'conjuring', count: number = 1) {
    const pos = getCharacterPosition(target);
    triggerHop(pos.row, pos.col, count);
  }

  /**
   * Stop all active hops
   */
  function clearAllHops() {
    state.sceneState.activeHops.clear();
    drawTiles(true);
  }

  /**
   * Tick all active hop animations (called every ANIMATION_INTERVAL)
   * Each hop = 2 frames (up on frame 0, down on frame 1)
   */
  function tickHops() {
    let anyActive = false;
    const toRemove: string[] = [];

    for (const [key, hopState] of state.sceneState.activeHops) {
      anyActive = true;

      // Advance frame within current hop
      if (hopState.frameInHop === 0) {
        // Was up, now go down
        playSfx('jump');
        hopState.frameInHop = 1;
      } else {
        // Was down, complete this hop
        hopState.remaining--;
        if (hopState.remaining <= 0) {
          toRemove.push(key);
        } else {
          // Start next hop
          hopState.frameInHop = 0;
        }
      }
    }

    // Remove completed hops
    for (const key of toRemove) {
      state.sceneState.activeHops.delete(key);
    }

    return anyActive || toRemove.length > 0;
  }

  function startAnimation() {
    animationInterval = setInterval(() => {
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

      // Auto-clear chat bubble after 5 seconds
      if (state.sceneState.chatBubbleTarget && Date.now() - state.chatBubbleStartTime > 5000) {
        state.sceneState.chatBubbleTarget = null;
        drawTiles(true); // Force redraw to remove bubble
      }

      // Tick hop animations and redraw if any are active
      const hasHops = tickHops();

      // Animate bubbles when waiting (toggle every ~1 second based on animationFrame)
      if (state.waitingFor !== 'none') {
        // Show bubbles for frames 0-3, hide for frames 4-7 (toggles every 1 second)
        state.sceneState.bubbleVisible = state.animationFrame < 4;
      }

      if (hasHops || state.waitingFor !== 'none') {
        drawTiles();
        drawChat(); // Update chat working indicator
      }
    }, ANIMATION_INTERVAL);
  }

  function stopAnimation() {
    if (animationInterval) {
      clearInterval(animationInterval);
      animationInterval = null;
    }
  }

  /**
   * Animate the arbiter walking to a target position
   * Old arbiter shuffles slowly - 1300ms per step
   *
   * Position mapping:
   * - Pos 3: by fire (row 3, col 4) - starting position
   * - Pos 2: by cauldron (row 2, col 4) - working position
   * - Pos 1: center (row 2, col 3)
   * - Pos 0: near human (row 2, col 2)
   */
  function animateArbiterWalk(
    targetPos: -1 | 0 | 1 | 2 | 3,
    onComplete?: () => void
  ) {
    // Clear any existing walk animation
    if (arbiterWalkInterval) {
      clearInterval(arbiterWalkInterval);
      arbiterWalkInterval = null;
    }

    const currentPos = state.sceneState.arbiterPos;
    if (currentPos === targetPos) {
      onComplete?.();
      return;
    }

    const direction = targetPos > currentPos ? 1 : -1;

    arbiterWalkInterval = setInterval(() => {
      const newPos = state.sceneState.arbiterPos + direction;

      // Type-safe position clamping
      if (newPos >= -1 && newPos <= 3) {
        state.sceneState.arbiterPos = newPos as -1 | 0 | 1 | 2 | 3;
        playSfx('footstep');
        drawTiles(true); // Force redraw for walk animation

        if (newPos === targetPos) {
          clearInterval(arbiterWalkInterval!);
          arbiterWalkInterval = null;
          onComplete?.();
        }
      } else {
        clearInterval(arbiterWalkInterval!);
        arbiterWalkInterval = null;
        onComplete?.();
      }
    }, 1000); // 1 second per step, 3 seconds for full walk
  }

  // ============================================================================
  // Summon Sequence Functions
  // ============================================================================

  /**
   * Start the summon sequence: walk to fire position, show spellbook, then process demon queue.
   * Called when mode changes to 'arbiter_to_orchestrator'.
   * Reuses animateArbiterWalk for the walking animation.
   */
  function startSummonSequence() {
    if (summonState !== 'idle') return; // Already summoning or dismissing

    summonState = 'walking';
    animateArbiterWalk(3, () => {  // Pos 3 = by fire (row 3, col 4)
      // Walk complete - show spellbook after brief pause
      setTimeout(() => {
        state.sceneState.showSpellbook = true;
        drawTiles(true);
        summonState = 'ready';
        // Process any demons that queued during the walk
        processQueuedSpawns();
      }, ANIMATION_INTERVAL);
    });
  }

  /**
   * Queue a demon to spawn. If already at cauldron (ready), shows immediately.
   * If still walking, demon appears after walk + spellbook sequence completes.
   */
  function queueDemonSpawn(demonNumber: number) {
    pendingDemonSpawns.push(demonNumber);

    if (summonState === 'ready') {
      // Already at cauldron with spellbook, process immediately
      processQueuedSpawns();
    } else if (summonState === 'idle') {
      // Not at cauldron yet, start the sequence
      startSummonSequence();
    }
    // If 'walking' or 'dismissing', demon will be processed when sequence completes
  }

  /**
   * Process demons from the queue, showing them one at a time with a pause between each.
   */
  function processQueuedSpawns() {
    if (summonState !== 'ready') return;
    if (pendingDemonSpawns.length === 0) return;

    const nextDemon = pendingDemonSpawns.shift()!;

    // Brief pause, then show demon
    setTimeout(() => {
      state.sceneState.demonCount = nextDemon;
      playSfx('magic');
      drawTiles(true);
      // Process next demon if any (recursive with delay)
      if (pendingDemonSpawns.length > 0) {
        processQueuedSpawns();
      }
    }, ANIMATION_INTERVAL * 2); // ~500ms pause before each demon appears
  }

  /**
   * Start the dismiss sequence: hide spellbook, clear demons, walk back to human.
   * Called when orchestrators are disconnected or mode changes back.
   */
  function startDismissSequence() {
    // Clear any pending spawns
    pendingDemonSpawns = [];

    // If already idle or dismissing, nothing to do
    if (summonState === 'idle' || summonState === 'dismissing') return;

    summonState = 'dismissing';

    // Hide spellbook and clear demons immediately
    state.sceneState.showSpellbook = false;
    state.sceneState.demonCount = 0;
    drawTiles(true);

    // Walk back after brief pause
    setTimeout(() => {
      animateArbiterWalk(0, () => {
        summonState = 'idle';
      });
    }, ANIMATION_INTERVAL);
  }

  /**
   * Start the arbiter walk animation from fire to human position.
   * Called either directly from entrance sequence (no requirements prompt)
   * or after user selects a requirements file.
   */
  function startArbiterWalk() {
    animateArbiterWalk(0, () => {
      // Arbiter arrived at scroll - show alert/exclamation indicator
      state.sceneState.alertTarget = 'arbiter';
      drawTiles(true);

      // Pause to let user see the alert (~1.5 seconds)
      setTimeout(() => {
        state.sceneState.alertTarget = null;
        drawTiles(true);

        // Now complete entrance and show message
        entranceComplete = true;
        if (pendingArbiterMessage) {
          addMessage('arbiter', pendingArbiterMessage);
          pendingArbiterMessage = null;
        }
      }, 1500);
    });
  }

  /**
   * Run the full entrance sequence:
   * 1. Human walks in from left (col 0 → 1)
   * 2. Human hops twice (surprised)
   * 3. Arbiter hops twice (notices visitor)
   * 4. Requirements prompt shows (if needed) - arbiter still at starting position
   * 5. After user selects file (or if no prompt needed), arbiter walks to human
   */
  function runEntranceSequence() {
    // Show "the arbiter approaches" message
    addMessage('system', 'The arbiter approaches...');

    // Timeline:
    // 0ms: human at col 0
    // 400ms: human walks to col 1
    // 900ms: human hops twice (takes 1000ms, ends ~1900ms)
    // 1800ms: arbiter hops twice (takes 1000ms, ends ~2800ms)
    // 2800ms: requirements prompt shows (if needed), OR arbiter starts walking
    // After user selects file: arbiter walks

    // Step 1: Human walks in (already at col 0, moves to col 1)
    setTimeout(() => {
      if (!isRunning) return;
      state.sceneState.humanCol = 1;
      drawTiles(true);
    }, 400);

    // Step 2: Human hops twice (surprised to see the arbiter)
    setTimeout(() => {
      if (!isRunning) return;
      triggerCharacterHop('human', 2);
    }, 900);

    // Step 3: Arbiter hops twice at fire position (notices the visitor)
    // Wait longer so human finishes hopping first
    setTimeout(() => {
      if (!isRunning) return;
      triggerCharacterHop('arbiter', 2);
    }, 1800);

    // Step 4: After hops complete (~2800ms), check if we need requirements prompt
    setTimeout(() => {
      if (!isRunning) return;
      if (needsRequirementsPrompt) {
        // Show requirements overlay BEFORE arbiter walks
        state.requirementsOverlay = 'prompt';
        inRequirementsOverlay = true;  // Prevent animation interval from overwriting
        loadFilesForPicker();  // Pre-load files
        drawRequirementsOverlay();
        // Arbiter will walk after user selects file (in selectRequirementsFile)
      } else {
        // No requirements prompt needed (CLI arg provided)
        // Signal ready and start walk
        if (requirementsReadyCallback) {
          requirementsReadyCallback();
          requirementsReadyCallback = null;
        }
        startArbiterWalk();
      }
    }, 2800);
  }

  // ============================================================================
  // Router Callbacks
  // ============================================================================

  function getRouterCallbacks(): RouterCallbacks {
    return {
      onHumanMessage: (text: string) => {
        addMessage('human', text);
        // Hide tool indicator on message
        state.showToolIndicator = false;
        state.recentTools = [];
        state.toolCountSinceLastMessage = 0;
      },

      onArbiterMessage: (text: string) => {
        // If entrance animation isn't complete, queue the message
        if (!entranceComplete) {
          pendingArbiterMessage = text;
        } else {
          addMessage('arbiter', text);
        }
        // Unlock input now that arbiter has spoken
        state.arbiterHasSpoken = true;
        // Hide tool indicator on message
        state.showToolIndicator = false;
        state.recentTools = [];
        state.toolCountSinceLastMessage = 0;
      },

      onOrchestratorMessage: (orchestratorNumber: number, text: string) => {
        addMessage('orchestrator', text, orchestratorNumber);
        // Hide tool indicator on message
        state.showToolIndicator = false;
        state.recentTools = [];
        state.toolCountSinceLastMessage = 0;
      },

      onContextUpdate: (arbiterPercent: number, orchestratorPercent: number | null) => {
        state.arbiterContextPercent = arbiterPercent;
        state.orchestratorContextPercent = orchestratorPercent;
        drawContext();
      },

      onToolUse: (tool: string, count: number) => {
        state.currentTool = tool;
        state.toolCallCount = count;
        state.lastToolTime = Date.now();

        // Update tool indicator state
        state.toolCountSinceLastMessage++;
        state.showToolIndicator = true;
        // Keep last 2 tools
        if (state.recentTools.length === 0 || state.recentTools[state.recentTools.length - 1] !== tool) {
          state.recentTools.push(tool);
          if (state.recentTools.length > 2) {
            state.recentTools.shift();
          }
        }

        drawContext();
        drawChat();  // Also redraw chat for tool indicator
      },

      onModeChange: (mode: AppState['mode']) => {
        // Use summon/dismiss sequences for coordinated animation
        if (mode === 'arbiter_to_orchestrator') {
          // Start walking to cauldron - demons will appear after walk + spellbook
          startSummonSequence();
        } else {
          // Leaving work position - hide spellbook, clear demons, walk back
          startDismissSequence();
        }
      },

      onWaitingStart: (waitingFor: 'arbiter' | 'orchestrator') => {
        // Ignore waiting during entrance sequence - don't want arbiter hopping early
        if (!entranceComplete) return;

        state.waitingFor = waitingFor;
        // Hop for 3 seconds (6 hops at 500ms each)
        const target = waitingFor === 'arbiter' ? 'arbiter' : 'conjuring';
        triggerCharacterHop(target, 6);
        // Turn on bubbles (stays on until work is done)
        state.sceneState.bubbleVisible = true;
        drawTiles(true);
        drawChat(true);
      },

      onWaitingStop: () => {
        state.waitingFor = 'none';
        // Clear any remaining hops
        clearAllHops();
        // Turn off bubbles
        state.sceneState.bubbleVisible = false;
        drawTiles(true);
        drawChat(true);
      },

      onOrchestratorSpawn: (orchestratorNumber: number) => {
        // Queue the demon to appear after walk + spellbook sequence completes
        queueDemonSpawn(orchestratorNumber);
      },

      onOrchestratorDisconnect: () => {
        // Run dismiss sequence (clears demons, hides spellbook, walks back)
        startDismissSequence();
        // Also clear orchestrator UI state
        state.orchestratorContextPercent = null;
        state.currentTool = null;
        state.toolCallCount = 0;
        drawContext();
      },

      onCrashCountUpdate: (count: number) => {
        state.crashCount = count;
        drawContext(true);  // Force redraw
      },

      onDebugLog: (entry: DebugLogEntry) => {
        // Write to debug log file
        const timestamp = new Date().toISOString();
        let logLine = `[${timestamp}] [${entry.type.toUpperCase()}]`;

        if (entry.agent) {
          logLine += ` [${entry.agent}]`;
        }
        if (entry.speaker) {
          logLine += ` ${entry.speaker}:`;
        }
        if (entry.messageType) {
          logLine += ` (${entry.messageType})`;
        }
        logLine += ` ${entry.text}`;

        // Add full details as JSON if present
        if (entry.details) {
          logLine += `\n    DETAILS: ${JSON.stringify(entry.details, null, 2).split('\n').join('\n    ')}`;
        }

        logLine += '\n';

        // Ensure directory exists and append to file
        try {
          const dir = path.dirname(DEBUG_LOG_PATH);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.appendFileSync(DEBUG_LOG_PATH, logLine);
        } catch (err) {
          // Silently ignore write errors
        }
      },
    };
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
    } catch (err) {
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

    // Start animation timer
    startAnimation();

    // Always run the full entrance sequence
    // Human walks in, both characters hop, arbiter walks to human
    // Requirements overlay shows AFTER entrance completes (if no CLI arg)
    runEntranceSequence();

    // Set up input handling
    term.grabInput(true);

    // Helper to properly suspend the process
    const suspendProcess = () => {
      // Restore terminal to cooked mode
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
      }
      // Remove any SIGTSTP listeners so the default suspend behavior happens
      process.removeAllListeners('SIGTSTP');
      // Send SIGTSTP to process group (0) for proper job control
      process.kill(0, 'SIGTSTP');
    };

    // Raw stdin handler for Ctrl-\ (0x1c) - terminal-kit doesn't emit this as a key
    process.stdin.on('data', (data: Buffer) => {
      if (data.includes(0x1c)) {  // Ctrl-\ = ASCII 28 = 0x1c
        process.kill(process.pid, 'SIGQUIT');
      }
    });

    term.on('key', (key: string) => {
      // Handle requirements overlay first (takes priority)
      if (state.requirementsOverlay !== 'none') {
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
        requirementsKeyHandler(key);
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

    stopAnimation();
    term.fullscreen(false);
    term.grabInput(false);
    term.hideCursor(false);
    term.styleReset();

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
      console.log(`\n\x1b[33m⚠ Session had ${appState.crashCount} crash${appState.crashCount > 1 ? 'es' : ''} (recovered)\x1b[0m`);
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
    // Hop for 3 seconds (6 hops at 500ms each)
    const target = waitingFor === 'arbiter' ? 'arbiter' : 'conjuring';
    triggerCharacterHop(target, 6);
    // Turn on bubbles
    state.sceneState.bubbleVisible = true;
    drawTiles(true);

    // Auto-scroll to show the working indicator using single source of truth
    const layout = getLayout(state.inputBuffer);
    const renderedLines = getRenderedChatLines(layout.chatArea.width);
    state.scrollOffset = Math.max(0, renderedLines.length - layout.chatArea.height);
    drawChat(true);
  }

  function stopWaiting(): void {
    state.waitingFor = 'none';
    // Clear any remaining hops and turn off bubbles
    clearAllHops();
    state.sceneState.bubbleVisible = false;
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
