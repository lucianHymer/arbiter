// Main entry point for the Arbiter system
// Ties together state, router, and TUI for the hierarchical AI orchestration system

import { createInitialState, AppState } from './state.js';
import { Router } from './router.js';
import { createTUI, TUI } from './tui/index.js';
import { showCharacterSelect } from './tui/screens/character-select.js';
import { showForestIntro } from './tui/screens/forest-intro.js';

/**
 * Session information for persistence on exit
 * Output to stderr for resume capability
 */
interface SessionInfo {
  arbiter: string | null;
  lastOrchestrator: string | null;
  orchestratorNumber: number | null;
}

/**
 * Outputs session information to stderr for resume capability
 * Format per architecture doc:
 * {"arbiter": "session-abc", "lastOrchestrator": "session-xyz", "orchestratorNumber": 3}
 */
function outputSessionInfo(state: AppState): void {
  const sessionInfo: SessionInfo = {
    arbiter: state.arbiterSessionId,
    lastOrchestrator: state.currentOrchestrator?.sessionId ?? null,
    orchestratorNumber: state.currentOrchestrator?.number ?? null,
  };

  // Output to stderr so it doesn't interfere with TUI output
  process.stderr.write(JSON.stringify(sessionInfo) + '\n');
}

/**
 * Main application entry point
 * Creates and wires together all components of the Arbiter system
 */
async function main(): Promise<void> {
  // Track components for cleanup
  let tui: TUI | null = null;
  let router: Router | null = null;
  let state: AppState | null = null;
  let isShuttingDown = false;

  /**
   * Graceful shutdown handler
   * Stops router, stops TUI, outputs session info, and exits
   */
  async function shutdown(exitCode: number = 0): Promise<void> {
    // Prevent multiple shutdown calls
    if (isShuttingDown) return;
    isShuttingDown = true;

    // Stop router first (aborts any running queries)
    if (router) {
      await router.stop();
    }

    // Stop TUI (restores terminal)
    if (tui) {
      tui.stop();
    }

    // Output session info for resume capability
    if (state) {
      outputSessionInfo(state);
    }

    process.exit(exitCode);
  }

  // Set up signal handlers for graceful shutdown
  process.on('SIGINT', () => {
    shutdown(0);
  });

  process.on('SIGTERM', () => {
    shutdown(0);
  });

  try {
    // Show character selection screen first
    const selectedCharacter = await showCharacterSelect();

    // Show animated forest intro with selected character
    await showForestIntro(selectedCharacter);

    // Create initial application state
    state = createInitialState();

    // Create TUI with state reference and selected character
    tui = createTUI(state, selectedCharacter);

    // Get router callbacks from TUI
    // These callbacks update the display when router events occur
    const routerCallbacks = tui.getRouterCallbacks();

    // Create router with state and callbacks
    router = new Router(state, routerCallbacks);

    // Wire TUI input to router
    // When user submits input, send it to the router
    tui.onInput(async (text: string) => {
      if (router) {
        await router.sendHumanMessage(text);
      }
    });

    // Start TUI (takes over terminal)
    tui.start();

    // Start router (initializes Arbiter session)
    await router.start();

    // Keep the process running
    // The TUI and router handle events asynchronously
    // We wait indefinitely until shutdown signal is received
    await new Promise<void>(() => {
      // This promise never resolves - we exit via shutdown()
    });
  } catch (error) {
    // Handle errors: stop TUI, output error, exit with code 1
    if (tui) {
      tui.stop();
    }

    // Output error to stderr
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);

    // Output session info even on error for potential recovery
    if (state) {
      outputSessionInfo(state);
    }

    process.exit(1);
  }
}

// Self-executing entry point
main();
