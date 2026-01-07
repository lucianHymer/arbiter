/**
 * Terminal-Kit based TUI using Strategy 5 (Minimal Redraws)
 *
 * This replaces the Ink-based TUI with a terminal-kit implementation
 * that uses minimal redraws for flicker-free animation and input handling.
 */

import termKit from 'terminal-kit';
import * as fs from 'fs';
import * as path from 'path';
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
  mode: 'NORMAL' | 'INSERT';

  // Status info
  arbiterContextPercent: number;
  orchestratorContextPercent: number | null;
  currentTool: string | null;
  toolCallCount: number;

  // Animation state
  animationFrame: number;
  waitingFor: WaitingState;

  // Exit confirmation state
  pendingExit: boolean;
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
  lastTool: string | null;
  lastWaitingFor: WaitingState;
}

// ============================================================================
// Constants
// ============================================================================

// Scene dimensions
const SCENE_WIDTH = 7;
const SCENE_HEIGHT = 6;
const TILE_AREA_WIDTH = SCENE_WIDTH * TILE_SIZE; // 112 chars
const TILE_AREA_HEIGHT = SCENE_HEIGHT * CHAR_HEIGHT; // 48 rows

// Animation
const ANIMATION_INTERVAL = 250; // ms

// Debug log file (temporary, cleared each session)
const DEBUG_LOG_PATH = path.join(process.cwd(), '.claude', '.arbiter.tmp.log');

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

function getLayout() {
  let width = 180;
  let height = 50;

  if (typeof term.width === 'number' && isFinite(term.width) && term.width > 0) {
    width = term.width;
  }
  if (typeof term.height === 'number' && isFinite(term.height) && term.height > 0) {
    height = term.height;
  }

  // Left side: tile scene
  const tileAreaX = 1;
  const tileAreaY = 1;

  // Right side: chat, status, input
  const chatAreaX = TILE_AREA_WIDTH + 3; // Leave 1 col gap
  const chatAreaY = 1;
  const chatAreaWidth = Math.max(40, width - chatAreaX - 1);
  const chatAreaHeight = height - 4; // Leave room for status and input

  const statusY = height - 2;
  const inputY = height - 1;

  return {
    width,
    height,
    tileArea: {
      x: tileAreaX,
      y: tileAreaY,
      width: TILE_AREA_WIDTH,
      height: TILE_AREA_HEIGHT,
    },
    chatArea: {
      x: chatAreaX,
      y: chatAreaY,
      width: chatAreaWidth,
      height: chatAreaHeight,
    },
    statusBar: {
      x: chatAreaX,
      y: statusY,
      width: chatAreaWidth,
    },
    inputLine: {
      x: chatAreaX,
      y: inputY,
      width: chatAreaWidth,
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
    },
    messages: [],
    scrollOffset: 0,
    inputBuffer: '',
    mode: 'INSERT', // Start in insert mode
    arbiterContextPercent: 0,
    orchestratorContextPercent: null,
    currentTool: null,
    toolCallCount: 0,
    animationFrame: 0,
    waitingFor: 'none',
    pendingExit: false,
  };

  // Tracking for minimal redraws
  const tracker: RedrawTracker = {
    lastTileFrame: -1,
    lastScrollOffset: -1,
    lastInputBuffer: '',
    lastMode: 'INSERT',
    lastMessageCount: -1,
    lastContextPercent: -1,
    lastTool: null,
    lastWaitingFor: 'none',
  };

  // Callbacks
  let inputCallback: ((text: string) => void) | null = null;
  let exitCallback: (() => void) | null = null;
  let animationInterval: NodeJS.Timeout | null = null;
  let isRunning = false;
  let inLogViewer = false; // Track when log viewer is open
  let entranceComplete = false; // Track if entrance animation is done
  let pendingArbiterMessage: string | null = null; // Message waiting for entrance to complete
  let arbiterWalkInterval: NodeJS.Timeout | null = null; // For walk animations

  // ============================================================================
  // Drawing Functions (Strategy 5 - Minimal Redraws)
  // ============================================================================

  /**
   * Draw tile scene
   * @param force Force redraw even if animation frame unchanged
   */
  function drawTiles(force: boolean = false) {
    if (!force && state.animationFrame === tracker.lastTileFrame) return;
    tracker.lastTileFrame = state.animationFrame;

    // Skip drawing if log viewer is open (but state still updates)
    if (inLogViewer) return;

    if (!state.tileset) return;
    const layout = getLayout();

    // Create scene from state
    const scene = createScene(state.sceneState);

    // Render scene to ANSI string (activeHops from sceneState)
    const sceneStr = renderScene(
      state.tileset,
      scene,
      state.sceneState.activeHops
    );

    // Split by lines and write each line
    const lines = sceneStr.split('\n');
    for (let i = 0; i < lines.length; i++) {
      term.moveTo(layout.tileArea.x, layout.tileArea.y + i);
      process.stdout.write(lines[i] + RESET);
    }
  }

  /**
   * Draw chat area - only redraws if messages or scroll changed
   */
  function drawChat(force: boolean = false) {
    const scrollChanged = state.scrollOffset !== tracker.lastScrollOffset;
    const messagesChanged = state.messages.length !== tracker.lastMessageCount;

    if (!force && !scrollChanged && !messagesChanged) return;

    tracker.lastScrollOffset = state.scrollOffset;
    tracker.lastMessageCount = state.messages.length;

    const layout = getLayout();
    const visibleLines = layout.chatArea.height;

    // Calculate max scroll
    const totalLines = state.messages.reduce((acc, msg) => {
      return acc + getMessageLineCount(msg, layout.chatArea.width);
    }, 0);
    const maxScroll = Math.max(0, totalLines - visibleLines);
    state.scrollOffset = Math.min(Math.max(0, state.scrollOffset), maxScroll);

    // Render messages to line array (with 1-line padding between messages)
    const renderedLines: { text: string; color: string }[] = [];
    for (let i = 0; i < state.messages.length; i++) {
      const msg = state.messages[i];
      const prefix = getMessagePrefix(msg);
      const color = getMessageColor(msg.speaker);
      const wrappedLines = wrapText(prefix + msg.text, layout.chatArea.width);
      for (const line of wrappedLines) {
        renderedLines.push({ text: line, color });
      }
      // Add blank line between messages (but not after the last one)
      if (i < state.messages.length - 1) {
        renderedLines.push({ text: '', color: COLORS.reset });
      }
    }

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
   * Draw status bar - only redraws if status changed
   */
  function drawStatus(force: boolean = false) {
    const contextChanged =
      state.arbiterContextPercent !== tracker.lastContextPercent ||
      state.currentTool !== tracker.lastTool ||
      state.waitingFor !== tracker.lastWaitingFor;

    if (!force && !contextChanged) return;

    tracker.lastContextPercent = state.arbiterContextPercent;
    tracker.lastTool = state.currentTool;
    tracker.lastWaitingFor = state.waitingFor;

    const layout = getLayout();
    const statusX = layout.statusBar.x;
    const statusY = layout.statusBar.y;
    const statusWidth = layout.statusBar.width;

    // Clear the status line
    term.moveTo(statusX, statusY);
    process.stdout.write(' '.repeat(statusWidth));

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

    // Build left side (mode + hints)
    let leftSide = '';
    let leftLen = 0; // Track visible length (no ANSI codes)

    if (state.mode === 'INSERT') {
      leftSide += '\x1b[42;30m INSERT \x1b[0m'; // Green bg, black text
      leftSide += '\x1b[2m    esc:normal  ·  <ctrl-c>:quit \x1b[0m'; // Dim hint with spacing
      leftLen = 8 + 34; // " INSERT " + "    esc:normal  ·  <ctrl-c>:quit "
    } else {
      leftSide += '\x1b[48;2;130;44;19m\x1b[97m NORMAL \x1b[0m'; // Brown bg (130,44,19), bright white text
      leftSide += '\x1b[2m    i:insert  ·  j/k:scroll  ·  o:log  ·  <ctrl-c>:quit \x1b[0m'; // Dim hint with spacing
      leftLen = 8 + 57; // " NORMAL " + "    i:insert  ·  j/k:scroll  ·  o:log  ·  <ctrl-c>:quit "
    }

    // Build right side (context + tool + waiting)
    let rightSide = '';
    let rightLen = 0;

    // Context percentage
    const arbiterCtx = `Arbiter: ${state.arbiterContextPercent.toFixed(1)}%`;
    rightSide += `\x1b[33m${arbiterCtx}\x1b[0m`;
    rightLen += arbiterCtx.length;

    if (state.orchestratorContextPercent !== null) {
      const orchCtx = ` | Conjuring: ${state.orchestratorContextPercent.toFixed(1)}%`;
      rightSide += `\x1b[36m${orchCtx}\x1b[0m`;
      rightLen += orchCtx.length;
    }

    // Tool info
    if (state.currentTool) {
      const toolInfo = ` | ${state.currentTool} (${state.toolCallCount})`;
      rightSide += `\x1b[35m${toolInfo}\x1b[0m`;
      rightLen += toolInfo.length;
    }

    // Waiting indicator
    if (state.waitingFor !== 'none') {
      const dots = '.'.repeat((state.animationFrame % 3) + 1);
      const waiting = state.waitingFor === 'arbiter' ? 'Arbiter' : 'Conjuring';
      const waitInfo = ` | ${waiting} thinking${dots}`;
      rightSide += `\x1b[2m${waitInfo}\x1b[0m`;
      rightLen += waitInfo.length;
    }

    // Calculate spacing between left and right
    const spacing = Math.max(1, statusWidth - leftLen - rightLen);

    term.moveTo(statusX, statusY);
    process.stdout.write(leftSide + ' '.repeat(spacing) + rightSide);
  }

  /**
   * Draw input line - only redraws if input changed
   */
  function drawInput(force: boolean = false) {
    const inputChanged = state.inputBuffer !== tracker.lastInputBuffer || state.mode !== tracker.lastMode;

    if (!force && !inputChanged) return;

    tracker.lastInputBuffer = state.inputBuffer;
    tracker.lastMode = state.mode;

    const layout = getLayout();
    const inputX = layout.inputLine.x;
    const inputY = layout.inputLine.y;
    const inputWidth = layout.inputLine.width;

    // Clear the input line
    term.moveTo(inputX, inputY);
    process.stdout.write(' '.repeat(inputWidth));

    // Draw input with cursor
    term.moveTo(inputX, inputY);
    if (state.mode === 'INSERT') {
      term.cyan('> ');
      term.white(state.inputBuffer.substring(0, inputWidth - 4));
      term.bgWhite.black(' '); // Cursor
    } else {
      term.blue(': ');
      term.white(state.inputBuffer.substring(0, inputWidth - 4));
    }
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
    tracker.lastTool = null;
    tracker.lastWaitingFor = 'none';

    term.clear();
    drawTiles(true);
    drawChat(true);
    drawStatus(true);
    drawInput(true);
  }

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

  function getMessageLineCount(msg: Message, width: number): number {
    const prefix = getMessagePrefix(msg);
    const wrapped = wrapText(prefix + msg.text, width);
    return wrapped.length;
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

    // Auto-scroll to bottom
    const layout = getLayout();
    const totalLines = state.messages.reduce((acc, msg) => {
      return acc + getMessageLineCount(msg, layout.chatArea.width);
    }, 0);
    state.scrollOffset = Math.max(0, totalLines - layout.chatArea.height);

    drawChat();
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

  function handleInsertModeKey(key: string) {
    switch (key) {
      case 'ESCAPE':
        state.mode = 'NORMAL';
        drawStatus(true);
        drawInput(true);
        break;

      case 'ENTER':
        if (state.inputBuffer.trim()) {
          const text = state.inputBuffer.trim();
          state.inputBuffer = '';
          if (inputCallback) {
            inputCallback(text);
          }
        }
        drawInput(true);
        break;

      case 'BACKSPACE':
        state.inputBuffer = state.inputBuffer.slice(0, -1);
        drawInput();
        break;

      default:
        // Regular character
        if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) < 127) {
          state.inputBuffer += key;
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
        drawStatus(true);
        drawInput(true);
        break;

      case 'j':
        // Scroll down
        state.scrollOffset++;
        drawChat();
        break;

      case 'k':
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
        // Scroll to bottom
        const layout = getLayout();
        const totalLines = state.messages.reduce((acc, msg) => {
          return acc + getMessageLineCount(msg, layout.chatArea.width);
        }, 0);
        state.scrollOffset = Math.max(0, totalLines - layout.chatArea.height);
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
      process.stdout.write('\x1b[42;30m j/k:line  u/d:half  b/f:page  g/G:top/bottom  q:close  ^C:quit \x1b[0m');
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

      if (key === 'CTRL_C' || key === 'CTRL_Z') {
        // Close log viewer and show exit prompt
        term.off('key', logKeyHandler);
        inLogViewer = false;
        fullDraw();
        state.pendingExit = true;
        drawStatus(true);
        return;
      }

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

      // Tick hop animations and redraw if any are active
      const hasHops = tickHops();
      if (hasHops || state.waitingFor !== 'none') {
        drawTiles();
      }

      // Always update status (for the dots animation)
      drawStatus();
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

  /**
   * Run the full entrance sequence:
   * 1. Human walks in from left (col 0 → 1)
   * 2. Human hops twice (surprised)
   * 3. Arbiter hops twice (notices visitor)
   * 4. Arbiter walks from fire to human (3 steps) - starts quickly after hop
   */
  function runEntranceSequence() {
    // Show "the arbiter approaches" message
    addMessage('system', 'The arbiter approaches...');

    // Timeline:
    // 0ms: human at col 0
    // 400ms: human walks to col 1
    // 900ms: human hops twice (takes 1000ms, ends ~1900ms)
    // 1800ms: arbiter hops twice (takes 1000ms) - waits for human to finish
    // 2050ms: arbiter starts walking (quick start, 250ms after hop begins)
    // 5050ms: entrance complete

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

    // Step 4: Arbiter walks from pos 3 to pos 0 (starts quickly after hop begins)
    setTimeout(() => {
      if (!isRunning) return;
      animateArbiterWalk(0, () => {
        // Entrance complete - show any pending message
        entranceComplete = true;
        if (pendingArbiterMessage) {
          addMessage('arbiter', pendingArbiterMessage);
          pendingArbiterMessage = null;
        }
      });
    }, 2050);
  }

  // ============================================================================
  // Router Callbacks
  // ============================================================================

  function getRouterCallbacks(): RouterCallbacks {
    return {
      onHumanMessage: (text: string) => {
        addMessage('human', text);
      },

      onArbiterMessage: (text: string) => {
        // If entrance animation isn't complete, queue the message
        if (!entranceComplete) {
          pendingArbiterMessage = text;
        } else {
          addMessage('arbiter', text);
        }
      },

      onOrchestratorMessage: (orchestratorNumber: number, text: string) => {
        addMessage('orchestrator', text, orchestratorNumber);
      },

      onContextUpdate: (arbiterPercent: number, orchestratorPercent: number | null) => {
        state.arbiterContextPercent = arbiterPercent;
        state.orchestratorContextPercent = orchestratorPercent;
        drawStatus();
      },

      onToolUse: (tool: string, count: number) => {
        state.currentTool = tool;
        state.toolCallCount = count;
        drawStatus();
      },

      onModeChange: (mode: AppState['mode']) => {
        // Animate arbiter walking to new position with spellbook animation
        if (mode === 'arbiter_to_orchestrator') {
          // Going to work position: walk first, then show spellbook
          animateArbiterWalk(2, () => {
            // One frame delay, then show spellbook
            setTimeout(() => {
              state.sceneState.showSpellbook = true;
              drawTiles(true);
            }, ANIMATION_INTERVAL);
          });
        } else {
          // Leaving work position: hide spellbook first, then walk
          state.sceneState.showSpellbook = false;
          drawTiles(true);
          // One frame delay, then start walking
          setTimeout(() => {
            animateArbiterWalk(0);
          }, ANIMATION_INTERVAL);
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
        drawStatus();
      },

      onWaitingStop: () => {
        state.waitingFor = 'none';
        // Clear any remaining hops
        clearAllHops();
        // Turn off bubbles
        state.sceneState.bubbleVisible = false;
        drawTiles(true);
        drawStatus();
      },

      onOrchestratorSpawn: (orchestratorNumber: number) => {
        state.sceneState.demonCount = orchestratorNumber;
        drawTiles(true);
      },

      onOrchestratorDisconnect: () => {
        state.sceneState.demonCount = 0;
        state.orchestratorContextPercent = null;
        state.currentTool = null;
        state.toolCallCount = 0;
        drawTiles(true);
        drawStatus();
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

    // Run the full entrance sequence immediately
    // Human walks in, both characters hop, arbiter walks to human
    runEntranceSequence();

    // Set up input handling
    term.grabInput(true);

    term.on('key', (key: string) => {
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

      if (key === 'CTRL_C' || key === 'CTRL_Z') {
        // Show exit confirmation
        state.pendingExit = true;
        drawStatus(true);
        return;
      }
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

    isRunning = false;
  }

  function onInput(callback: (text: string) => void): void {
    inputCallback = callback;
  }

  function onExit(callback: () => void): void {
    exitCallback = callback;
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
    drawStatus();
  }

  function stopWaiting(): void {
    state.waitingFor = 'none';
    // Clear any remaining hops and turn off bubbles
    clearAllHops();
    state.sceneState.bubbleVisible = false;
    drawTiles(true);
    drawStatus();
  }

  return {
    start,
    stop,
    getRouterCallbacks,
    onInput,
    onExit,
    startWaiting,
    stopWaiting,
  };
}
