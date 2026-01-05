// TUI module entry point
// RPG-style terminal interface with wizard council theme

import blessed from 'blessed';
import { AppState, toRoman, updateArbiterContext, updateOrchestratorContext, updateOrchestratorTool } from '../state.js';
import { RouterCallbacks, DebugLogEntry } from '../router.js';
import { createLayout, LayoutElements, appendToLogbook, getTileAreaPosition } from './layout.js';
import { renderStatus, advanceAnimation, resetAnimation, WaitingState } from './render.js';
import { Logbook } from './logbook.js';
import { AnimationTimer, setAnimationActive } from './animations.js';
import { Tileset, loadTileset, HIDE_CURSOR, SHOW_CURSOR } from './tileset.js';
import { SceneState, createScene, renderScene as renderTileScene, createInitialSceneState } from './scene.js';

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

// Module-level tileset (loaded asynchronously)
let tileset: Tileset | null = null;

/**
 * Creates a TUI instance for the Arbiter system
 *
 * @param state - The application state to render
 * @param selectedCharacter - Optional tile index (190-197) for the selected human character
 * @returns TUI interface for controlling the terminal UI
 */
export function createTUI(state: AppState, selectedCharacter?: number): TUI {
  let elements: LayoutElements | null = null;
  let inputCallback: ((text: string) => void) | null = null;
  let isRunning = false;
  let waitingState: WaitingState = 'none';

  // Logbook instance for logging
  let logbook: Logbook | null = null;

  // Animation timer for campfire/gem animations
  let animationTimer: AnimationTimer | null = null;

  // Scene state for tile rendering
  let sceneState: SceneState = createInitialSceneState();

  // Set selected character if provided
  if (selectedCharacter !== undefined) {
    sceneState.selectedCharacter = selectedCharacter;
  }

  // Track orchestrator count for demon spawning
  let orchestratorCount = 0;

  // Track when hopping started (for 3-second limit)
  let hopStartTime: number | null = null;

  /**
   * Starts the waiting animation
   */
  function startWaiting(waitingFor: 'arbiter' | 'orchestrator'): void {
    waitingState = waitingFor;
    setAnimationActive(true);
    resetAnimation();

    // Update scene state for hop animation
    sceneState.workingTarget = waitingFor === 'arbiter' ? 'arbiter' : 'conjuring';

    // Reset hop start time so hopping begins fresh
    hopStartTime = null;

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

    // Clear scene state for hop animation
    sceneState.workingTarget = null;
    sceneState.hopFrame = false;
    sceneState.bubbleFrame = false;
    hopStartTime = null;

    // Render status without waiting state
    if (elements && isRunning) {
      renderStatus(elements, state, 'none');
    }
  }

  /**
   * Renders the tile scene to the right portion of the screen
   * Uses direct stdout writes over the blessed screen
   */
  function doRenderTileScene(): void {
    if (!tileset || !elements || !isRunning) return;

    const tileArea = getTileAreaPosition(elements.screen);
    const scene = createScene(sceneState);
    const rendered = renderTileScene(
      tileset,
      scene,
      sceneState.focusTarget,
      sceneState.workingTarget,
      sceneState.hopFrame
    );

    // Split rendered into lines and write each at correct position
    const lines = rendered.split('\n');
    for (let i = 0; i < lines.length && i < tileArea.height; i++) {
      process.stdout.write(`\x1b[${tileArea.y + i};${tileArea.x}H${lines[i]}`);
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

    // Hide cursor during rendering
    process.stdout.write(HIDE_CURSOR);

    // Create the layout
    elements = createLayout();
    isRunning = true;

    // Create logbook instance
    logbook = new Logbook();
    logbook.addSystemEvent('TUI started');

    // Create animation timer for campfire/gem animations
    animationTimer = new AnimationTimer(() => {
      if (elements && isRunning) {
        if (sceneState.workingTarget) {
          // Track when work started
          if (hopStartTime === null) {
            hopStartTime = Date.now();
          }

          const workingFor = Date.now() - hopStartTime;

          if (workingFor < 3000) {
            // First 3 seconds: hopping, NO bubbles
            sceneState.hopFrame = !sceneState.hopFrame;
            sceneState.bubbleFrame = false;
          } else {
            // After 3 seconds: bubbles, NO hopping
            sceneState.hopFrame = false;
            sceneState.bubbleFrame = !sceneState.bubbleFrame;
          }
        } else {
          hopStartTime = null;
          sceneState.hopFrame = false;
          sceneState.bubbleFrame = false;
        }

        // Re-render status bar for animated dots
        renderStatus(elements, state, waitingState);
        // Also re-render tile scene
        doRenderTileScene();
      }
    }, 300);

    // Start the animation timer
    animationTimer.start();

    // Set up input handling
    setupInputHandling();

    // Set up logbook toggle
    setupLogbookToggle();

    // Initial render - just status bar and tile scene (chat log is empty initially)
    renderStatus(elements, state, waitingState);
    doRenderTileScene();

    // Load tileset asynchronously and render when ready
    loadTileset().then((ts) => {
      tileset = ts;
      if (isRunning) {
        doRenderTileScene();
      }
    }).catch((err) => {
      // Log tileset loading error but continue without tile rendering
      if (logbook) {
        logbook.addSystemEvent(`Failed to load tileset: ${err.message}`);
      }
    });

    // Handle resize
    elements.screen.on('resize', () => {
      if (elements) {
        renderStatus(elements, state, waitingState);
        doRenderTileScene();
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

    // Show cursor again
    process.stdout.write(SHOW_CURSOR);
  }

  /**
   * Creates router callbacks that update the display
   */
  function getRouterCallbacks(): RouterCallbacks {
    return {
      onHumanMessage: (text: string) => {
        if (!elements || !isRunning) return;

        // Update scene state - focus on human
        sceneState.focusTarget = 'human';

        // Log the message to logbook (human messages don't come via onDebugLog)
        if (logbook) {
          logbook.addMessage('human', text);
        }

        // Append to AIM-style chat log
        elements.chatLog.log('{green-fg}You:{/green-fg} ' + text);
        doRenderTileScene();
      },

      onArbiterMessage: (text: string) => {
        if (!elements || !isRunning) return;

        // Update scene state - focus on arbiter
        sceneState.focusTarget = 'arbiter';

        // Note: Logging is handled by onDebugLog callback
        // This callback only handles main chat display

        // Append to AIM-style chat log
        elements.chatLog.log('{yellow-fg}Arbiter:{/yellow-fg} ' + text);
        doRenderTileScene();
      },

      onOrchestratorMessage: (orchestratorNumber: number, text: string) => {
        if (!elements || !isRunning) return;

        // Update scene state - focus on demon
        sceneState.focusTarget = 'demon';

        // Note: Logging is handled by onDebugLog callback
        // This callback only handles main chat display

        // Append to AIM-style chat log
        elements.chatLog.log('{cyan-fg}Conjuring ' + toRoman(orchestratorNumber) + ':{/cyan-fg} ' + text);
        doRenderTileScene();
      },

      onContextUpdate: (arbiterPercent: number, orchestratorPercent: number | null) => {
        if (!elements || !isRunning) return;

        // Update state with new context percentages
        updateArbiterContext(state, arbiterPercent);
        if (orchestratorPercent !== null) {
          updateOrchestratorContext(state, orchestratorPercent);
        }

        // Log the context update
        if (logbook) {
          logbook.addContextUpdate(arbiterPercent, orchestratorPercent);
        }

        // Render updated status bar (preserve waiting state for animation)
        renderStatus(elements, state, waitingState);
        doRenderTileScene();
      },

      onToolUse: (tool: string, count: number) => {
        if (!elements || !isRunning) return;

        // Update state with tool information
        updateOrchestratorTool(state, tool, count);

        // Note: Logging is handled by onDebugLog callback
        // This callback only handles state updates and display

        // Render updated status bar (preserve waiting state for animation)
        renderStatus(elements, state, waitingState);
        doRenderTileScene();
      },

      onModeChange: (mode: AppState['mode']) => {
        if (!elements || !isRunning) return;

        // Update scene state - arbiter position based on mode
        // 0 = near human (facing human), 2 = near spellbook (facing orchestrators)
        sceneState.arbiterPos = mode === 'human_to_arbiter' ? 0 : 2;
        sceneState.focusTarget = null;

        // Log the mode change
        if (logbook) {
          logbook.addModeChange(mode);
        }

        // Re-render tile scene to move Arbiter position
        doRenderTileScene();
      },

      onWaitingStart: (waitingFor: 'arbiter' | 'orchestrator') => {
        startWaiting(waitingFor);
        doRenderTileScene();
      },

      onWaitingStop: () => {
        stopWaiting();
        doRenderTileScene();
      },

      onOrchestratorSpawn: (orchestratorNumber: number) => {
        // Update demon count (max 5)
        orchestratorCount = Math.min(orchestratorNumber, 5);
        sceneState.demonCount = orchestratorCount;
        doRenderTileScene();
      },

      onOrchestratorDisconnect: () => {
        // Reset demon count
        orchestratorCount = 0;
        sceneState.demonCount = 0;
        doRenderTileScene();
      },

      onDebugLog: (entry: DebugLogEntry) => {
        if (!logbook) return;

        // Log to the logbook based on entry type
        switch (entry.type) {
          case 'message':
            logbook.addMessage(entry.speaker || 'unknown', entry.text, entry.filtered);
            break;
          case 'tool':
            // Parse tool details if available
            const toolDetails = entry.details as { tool: string; count: number } | undefined;
            if (toolDetails) {
              logbook.addToolUse(toolDetails.tool, toolDetails.count, entry.speaker);
            } else {
              logbook.addToolUse(entry.text, 1, entry.speaker);
            }
            break;
          case 'system':
            logbook.addSystemEvent(entry.text, entry.details);
            break;
        }
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
