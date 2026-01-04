// TUI module entry point
// Exports the terminal user interface components and initialization

import { AppState } from '../state.js';
import { RouterCallbacks } from '../router.js';
import { createLayout, LayoutElements } from './layout.js';
import { renderConversation, renderStatus, renderAll } from './render.js';

/**
 * TUI interface - main entry point for the terminal UI
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
}

/**
 * Box drawing characters for input prompt
 */
const BOX_CHARS = {
  leftT: '\u2560',       // ╠
  rightT: '\u2563',      // ╣
  horizontal: '\u2550',  // ═
  vertical: '\u2551',    // ║
  bottomLeft: '\u255A',  // ╚
  bottomRight: '\u255D', // ╝
};

/**
 * Creates a TUI instance for the Arbiter system
 *
 * @param state - The application state to render
 * @returns TUI interface for controlling the terminal UI
 */
export function createTUI(state: AppState): TUI {
  let elements: LayoutElements | null = null;
  let inputCallback: ((text: string) => void) | null = null;
  let isRunning = false;

  /**
   * Updates the input box with proper prompt styling
   */
  function updateInputBox(): void {
    if (!elements) return;

    const { inputBox, screen } = elements;
    const effectiveWidth = Math.max((screen.width as number) - 2, 78);

    // Create separator line above input
    const separator = BOX_CHARS.leftT + BOX_CHARS.horizontal.repeat(effectiveWidth) + BOX_CHARS.rightT;

    // Create input line with prompt
    const inputLine = BOX_CHARS.vertical + ' > ';

    // Create bottom border
    const bottomBorder = BOX_CHARS.bottomLeft + BOX_CHARS.horizontal.repeat(effectiveWidth) + BOX_CHARS.bottomRight;

    // Set label to show prompt
    inputBox.setLabel(' > ');

    screen.render();
  }

  /**
   * Sets up input handling for the textbox
   */
  function setupInputHandling(): void {
    if (!elements) return;

    const { inputBox, screen } = elements;

    // Handle submit event
    inputBox.on('submit', (value: string) => {
      if (value && value.trim() && inputCallback) {
        inputCallback(value.trim());
      }

      // Clear and refocus
      inputBox.clearValue();
      inputBox.focus();
      screen.render();
    });

    // Handle cancel (escape in input)
    inputBox.on('cancel', () => {
      inputBox.clearValue();
      inputBox.focus();
      screen.render();
    });

    // Focus the input box by default
    inputBox.focus();

    // Set up key bindings for input
    inputBox.key(['enter'], () => {
      inputBox.submit();
    });

    // Allow escape to cancel current input
    inputBox.key(['escape'], () => {
      inputBox.cancel();
    });
  }

  /**
   * Starts the TUI - creates layout and begins rendering
   */
  function start(): void {
    if (isRunning) return;

    // Create the layout
    elements = createLayout();
    isRunning = true;

    // Set up input handling
    setupInputHandling();

    // Update input box styling
    updateInputBox();

    // Initial render
    renderAll(elements, state);

    // Handle resize
    elements.screen.on('resize', () => {
      if (elements) {
        updateInputBox();
        renderAll(elements, state);
      }
    });
  }

  /**
   * Stops the TUI and cleans up
   */
  function stop(): void {
    if (!isRunning || !elements) return;

    // Destroy the screen
    elements.screen.destroy();
    elements = null;
    isRunning = false;
  }

  /**
   * Creates router callbacks that update the display
   */
  function getRouterCallbacks(): RouterCallbacks {
    return {
      onArbiterMessage: (text: string) => {
        if (!elements || !isRunning) return;

        // Render updated conversation
        renderConversation(elements, state);
      },

      onOrchestratorMessage: (orchestratorNumber: number, text: string) => {
        if (!elements || !isRunning) return;

        // Render updated conversation
        renderConversation(elements, state);
      },

      onContextUpdate: (arbiterPercent: number, orchestratorPercent: number | null) => {
        if (!elements || !isRunning) return;

        // Render updated status bar
        renderStatus(elements, state);
      },

      onToolUse: (tool: string, count: number) => {
        if (!elements || !isRunning) return;

        // Render updated status bar
        renderStatus(elements, state);
      },

      onModeChange: (mode: AppState['mode']) => {
        if (!elements || !isRunning) return;

        // Render updated status bar (mode affects orchestrator display)
        renderStatus(elements, state);
      },
    };
  }

  /**
   * Registers a callback for user input
   */
  function onInput(callback: (text: string) => void): void {
    inputCallback = callback;
  }

  return {
    start,
    stop,
    getRouterCallbacks,
    onInput,
  };
}

// Re-export types and utilities
export type { LayoutElements } from './layout.js';
export { renderProgressBar } from './render.js';
