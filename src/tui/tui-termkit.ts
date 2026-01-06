/**
 * Terminal-Kit based TUI using Strategy 5 (Minimal Redraws)
 *
 * This replaces the Ink-based TUI with a terminal-kit implementation
 * that uses minimal redraws for flicker-free animation and input handling.
 */

import termKit from 'terminal-kit';
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

// Colors
const COLORS = {
  human: '\x1b[32m', // green
  arbiter: '\x1b[33m', // yellow
  orchestrator: '\x1b[36m', // cyan
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
  let animationInterval: NodeJS.Timeout | null = null;
  let isRunning = false;

  // ============================================================================
  // Drawing Functions (Strategy 5 - Minimal Redraws)
  // ============================================================================

  /**
   * Draw tile scene - only redraws if animation frame changed
   */
  function drawTiles() {
    if (state.animationFrame === tracker.lastTileFrame) return;
    tracker.lastTileFrame = state.animationFrame;

    if (!state.tileset) return;
    const layout = getLayout();

    // Update scene state based on animation
    state.sceneState.hopFrame = state.animationFrame % 2 === 0;
    state.sceneState.bubbleFrame = state.animationFrame % 3 === 0;

    // Create scene from state
    const scene = createScene(state.sceneState);

    // Render scene to ANSI string
    const sceneStr = renderScene(
      state.tileset,
      scene,
      state.waitingFor !== 'none' ? (state.waitingFor === 'arbiter' ? 'arbiter' : 'conjuring') : null,
      state.sceneState.hopFrame
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

    // Render messages to line array
    const renderedLines: { text: string; color: string }[] = [];
    for (const msg of state.messages) {
      const prefix = getMessagePrefix(msg);
      const color = getMessageColor(msg.speaker);
      const wrappedLines = wrapText(prefix + msg.text, layout.chatArea.width);
      for (const line of wrappedLines) {
        renderedLines.push({ text: line, color });
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

    // Build status string
    let status = '';

    // Mode indicator
    if (state.mode === 'INSERT') {
      status += '\x1b[42;30m INSERT \x1b[0m '; // Green bg, black text
    } else {
      status += '\x1b[44;37m NORMAL \x1b[0m '; // Blue bg, white text
    }

    // Context percentage
    status += `\x1b[33mArbiter: ${state.arbiterContextPercent.toFixed(1)}%\x1b[0m`;

    if (state.orchestratorContextPercent !== null) {
      status += ` \x1b[36m| Conjuring: ${state.orchestratorContextPercent.toFixed(1)}%\x1b[0m`;
    }

    // Tool info
    if (state.currentTool) {
      status += ` \x1b[35m| ${state.currentTool} (${state.toolCallCount})\x1b[0m`;
    }

    // Waiting indicator
    if (state.waitingFor !== 'none') {
      const dots = '.'.repeat((state.animationFrame % 3) + 1);
      const waiting = state.waitingFor === 'arbiter' ? 'Arbiter' : 'Conjuring';
      status += ` \x1b[2m| ${waiting} thinking${dots}\x1b[0m`;
    }

    term.moveTo(statusX, statusY);
    process.stdout.write(status.substring(0, statusWidth * 2)); // Allow for ANSI codes
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
    drawTiles();
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
    const words = text.split(' ');
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length + word.length + 1 <= width) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);

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

      default:
        break;
    }
  }

  // ============================================================================
  // Animation
  // ============================================================================

  function startAnimation() {
    animationInterval = setInterval(() => {
      state.animationFrame = (state.animationFrame + 1) % 8;

      // Only redraw tiles if waiting (animation playing)
      if (state.waitingFor !== 'none') {
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

  // ============================================================================
  // Router Callbacks
  // ============================================================================

  function getRouterCallbacks(): RouterCallbacks {
    return {
      onHumanMessage: (text: string) => {
        addMessage('human', text);
      },

      onArbiterMessage: (text: string) => {
        addMessage('arbiter', text);
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
        // Update scene state based on app mode
        if (mode === 'arbiter_to_orchestrator') {
          state.sceneState.arbiterPos = 2; // Move arbiter to spellbook
        } else {
          state.sceneState.arbiterPos = 0; // Move arbiter back to human
        }
        drawTiles();
      },

      onWaitingStart: (waitingFor: 'arbiter' | 'orchestrator') => {
        state.waitingFor = waitingFor;
        state.sceneState.workingTarget = waitingFor === 'arbiter' ? 'arbiter' : 'conjuring';
        drawTiles();
        drawStatus();
      },

      onWaitingStop: () => {
        state.waitingFor = 'none';
        state.sceneState.workingTarget = null;
        drawTiles();
        drawStatus();
      },

      onOrchestratorSpawn: (orchestratorNumber: number) => {
        state.sceneState.demonCount = orchestratorNumber;
        drawTiles();
      },

      onOrchestratorDisconnect: () => {
        state.sceneState.demonCount = 0;
        state.orchestratorContextPercent = null;
        state.currentTool = null;
        state.toolCallCount = 0;
        drawTiles();
        drawStatus();
      },

      onDebugLog: (_entry: DebugLogEntry) => {
        // Debug logging - could be displayed in a separate panel
        // For now, we don't display debug logs in the main TUI
      },
    };
  }

  // ============================================================================
  // Public Interface
  // ============================================================================

  async function start(): Promise<void> {
    if (isRunning) return;
    isRunning = true;

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

    // Entry animation: after 400ms, move character from col 0 to col 1
    // This creates continuity from the forest intro where the character
    // walked off the right side and now enters the main scene from the left
    setTimeout(() => {
      if (isRunning) {
        state.sceneState.humanCol = 1; // Move to normal position
        tracker.lastTileFrame = -1; // Force tile redraw
        drawTiles();
      }
    }, 400);

    // Set up input handling
    term.grabInput(true);

    term.on('key', (key: string) => {
      if (key === 'CTRL_C' || key === 'CTRL_Z') {
        stop();
        process.exit(0);
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

    isRunning = false;
  }

  function onInput(callback: (text: string) => void): void {
    inputCallback = callback;
  }

  function startWaiting(waitingFor: 'arbiter' | 'orchestrator'): void {
    state.waitingFor = waitingFor;
    state.sceneState.workingTarget = waitingFor === 'arbiter' ? 'arbiter' : 'conjuring';
    drawTiles();
    drawStatus();
  }

  function stopWaiting(): void {
    state.waitingFor = 'none';
    state.sceneState.workingTarget = null;
    drawTiles();
    drawStatus();
  }

  return {
    start,
    stop,
    getRouterCallbacks,
    onInput,
    startWaiting,
    stopWaiting,
  };
}
