// TUI module entry point
// RPG-style terminal interface with wizard council theme

import blessed from 'blessed';
import { AppState, toRoman } from '../state.js';
import { RouterCallbacks } from '../router.js';
import { createLayout, LayoutElements, appendToLogbook } from './layout.js';
import { renderScene, renderStatus, renderAll, advanceAnimation, resetAnimation, WaitingState } from './render.js';
import { Logbook } from './logbook.js';
import { AnimationTimer, setAnimationActive } from './animations.js';

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
  /** Start the loading animation for arbiter or orchestrator */
  startWaiting(waitingFor: 'arbiter' | 'orchestrator'): void;
  /** Stop the loading animation */
  stopWaiting(): void;
}

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
  let waitingState: WaitingState = 'none';

  // Logbook instance for logging
  let logbook: Logbook | null = null;

  // Animation timer for campfire/gem animations
  let animationTimer: AnimationTimer | null = null;

  /**
   * Starts the waiting animation
   */
  function startWaiting(waitingFor: 'arbiter' | 'orchestrator'): void {
    waitingState = waitingFor;
    setAnimationActive(true);
    resetAnimation();

    // Render immediately with the new waiting state
    if (elements && isRunning) {
      renderStatus(elements, state, waitingState);
    }
  }

  /**
   * Stops the waiting animation
   */
  function stopWaiting(): void {
    waitingState = 'none';
    setAnimationActive(false);
    resetAnimation();

    // Render status without waiting state
    if (elements && isRunning) {
      renderStatus(elements, state, 'none');
    }
  }

  /**
   * Updates the logbook overlay content when visible
   */
  function updateLogbookOverlay(): void {
    if (!elements || !logbook || !elements.logbookContent) return;

    // Clear and re-populate with current view
    elements.logbookContent.setContent('');
    const entries = logbook.getCurrentView();
    for (const entry of entries) {
      elements.logbookContent.log(entry);
    }
  }

  /**
   * Sets up input handling for the textarea
   */
  function setupInputHandling(): void {
    if (!elements) return;

    const { inputBox, screen } = elements;

    // Focus the input box by default
    inputBox.focus();

    // Handle enter key to submit (textarea doesn't have submit event)
    inputBox.key(['enter'], () => {
      const value = inputBox.getValue();
      if (value && value.trim() && inputCallback) {
        inputCallback(value.trim());
      }
      inputBox.clearValue();
      inputBox.focus();
      screen.render();
    });

    // Allow escape to clear current input
    inputBox.key(['escape'], () => {
      inputBox.clearValue();
      inputBox.focus();
      screen.render();
    });
  }

  /**
   * Sets up logbook toggle handling
   */
  function setupLogbookToggle(): void {
    if (!elements || !elements.logbookOverlay) return;

    const { logbookOverlay, inputBox, screen } = elements;

    const toggleLogbook = () => {
      if (logbookOverlay.hidden) {
        // Update logbook content before showing
        updateLogbookOverlay();
        logbookOverlay.show();
        logbookOverlay.focus();
      } else {
        logbookOverlay.hide();
        inputBox.focus();
      }
      screen.render();
    };

    // The Ctrl+O key binding is already set up in layout.ts
    // We just need to hook into the show event to update content
    logbookOverlay.on('show', () => {
      updateLogbookOverlay();
      updateLogbookTitle();
    });

    // Add 'd' key handler to toggle between summary and debug modes
    logbookOverlay.key(['d', 'D'], () => {
      if (!logbook) return;

      // Toggle the mode
      logbook.toggleMode();

      // Refresh the display
      updateLogbookOverlay();

      // Update the logbook title to show current mode
      updateLogbookTitle();

      screen.render();
    });
  }

  /**
   * Updates the logbook title bar to show current mode
   */
  function updateLogbookTitle(): void {
    if (!elements || !elements.logbookOverlay || !logbook) return;

    const { screen } = elements;
    const mode = logbook.getMode();
    const modeLabel = mode === 'summary' ? 'SUMMARY' : 'DEBUG';

    // Find the title box (first child of logbookOverlay)
    const titleBox = elements.logbookOverlay.children[0] as blessed.Widgets.BoxElement;
    if (!titleBox) return;

    const width = Math.max((screen.width as number) - 2, 78);
    const title = `LOGBOOK [${modeLabel}]`;
    const hint = '[D] Toggle Mode  [Ctrl+O] Close';

    // Box drawing characters
    const BOX_CHARS = {
      topLeft: '\u2554',     // ╔
      topRight: '\u2557',    // ╗
      horizontal: '\u2550',  // ═
      vertical: '\u2551',    // ║
      leftT: '\u2560',       // ╠
      rightT: '\u2563',      // ╣
    };

    const topBorder = BOX_CHARS.topLeft + BOX_CHARS.horizontal.repeat(width) + BOX_CHARS.topRight;

    const titlePadding = Math.max(0, Math.floor((width - title.length) / 2));
    const hintStart = width - hint.length - 2;

    let titleLine = BOX_CHARS.vertical + ' '.repeat(titlePadding) + `{bold}${title}{/bold}`;
    const currentLen = titlePadding + title.length;
    const spacesToHint = hintStart - currentLen;
    titleLine += ' '.repeat(Math.max(0, spacesToHint)) + `{gray-fg}${hint}{/gray-fg}`;
    const remainingSpace = width - (titlePadding + title.length + Math.max(0, spacesToHint) + hint.length);
    titleLine += ' '.repeat(Math.max(0, remainingSpace)) + BOX_CHARS.vertical;

    const separator = BOX_CHARS.leftT + BOX_CHARS.horizontal.repeat(width) + BOX_CHARS.rightT;

    titleBox.setContent(topBorder + '\n' + titleLine + '\n' + separator);
  }

  /**
   * Starts the TUI - creates layout and begins rendering
   */
  function start(): void {
    if (isRunning) return;

    // Create the layout
    elements = createLayout();
    isRunning = true;

    // Create logbook instance
    logbook = new Logbook();
    logbook.addSystemEvent('TUI started');

    // Create animation timer for campfire/gem animations
    animationTimer = new AnimationTimer(() => {
      if (elements && isRunning) {
        // Re-render status bar for animated dots
        renderStatus(elements, state, waitingState);
      }
    }, 400);

    // Start the animation timer
    animationTimer.start();

    // Set up input handling
    setupInputHandling();

    // Set up logbook toggle
    setupLogbookToggle();

    // Initial render
    renderAll(elements, state);

    // Handle resize
    elements.screen.on('resize', () => {
      if (elements) {
        renderAll(elements, state);
      }
    });
  }

  /**
   * Stops the TUI and cleans up
   */
  function stop(): void {
    if (!isRunning || !elements) return;

    // Stop animation timer
    if (animationTimer) {
      animationTimer.stop();
      animationTimer = null;
    }

    // Close logbook (flush to file)
    if (logbook) {
      logbook.addSystemEvent('TUI stopped');
      logbook.close();
      logbook = null;
    }

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
      onHumanMessage: (text: string) => {
        if (!elements || !isRunning) return;

        // Log the message
        if (logbook) {
          logbook.addMessage('human', text);
        }

        // Render updated scene immediately so human message appears before response
        renderScene(elements, state);
      },

      onArbiterMessage: (text: string) => {
        if (!elements || !isRunning) return;

        // Log the message
        if (logbook) {
          logbook.addMessage('arbiter', text);
        }

        // Render updated scene
        renderScene(elements, state);
      },

      onOrchestratorMessage: (orchestratorNumber: number, text: string) => {
        if (!elements || !isRunning) return;

        // Log the message with Roman numeral
        if (logbook) {
          logbook.addMessage(`Orchestrator ${toRoman(orchestratorNumber)}`, text);
        }

        // Render updated scene
        renderScene(elements, state);
      },

      onContextUpdate: (arbiterPercent: number, orchestratorPercent: number | null) => {
        if (!elements || !isRunning) return;

        // Log the context update
        if (logbook) {
          logbook.addContextUpdate(arbiterPercent, orchestratorPercent);
        }

        // Render updated status bar (preserve waiting state for animation)
        renderStatus(elements, state, waitingState);
      },

      onToolUse: (tool: string, count: number) => {
        if (!elements || !isRunning) return;

        // Log the tool use
        if (logbook) {
          logbook.addToolUse(tool, count);
        }

        // Render updated status bar (preserve waiting state for animation)
        renderStatus(elements, state, waitingState);
      },

      onModeChange: (mode: AppState['mode']) => {
        if (!elements || !isRunning) return;

        // Log the mode change
        if (logbook) {
          logbook.addModeChange(mode);
        }

        // Re-render scene to move Arbiter position
        renderScene(elements, state);
      },

      onWaitingStart: (waitingFor: 'arbiter' | 'orchestrator') => {
        startWaiting(waitingFor);
      },

      onWaitingStop: () => {
        stopWaiting();
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
    startWaiting,
    stopWaiting,
  };
}

// Re-export types and utilities
export type { LayoutElements } from './layout.js';
export { renderProgressBar } from './render.js';
export type { WaitingState } from './render.js';
