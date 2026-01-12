#!/usr/bin/env node

// Main entry point for the Arbiter system
// Ties together state, router, and TUI for the hierarchical AI orchestration system

import fs from 'node:fs';
import { Router } from './router.js';
import { loadSession } from './session-persistence.js';
import { type AppState, createInitialState } from './state.js';
import {
  checkGitignore,
  createTUI,
  showCharacterSelect,
  showForestIntro,
  showTitleScreen,
  type TUI,
} from './tui/index.js';

/**
 * Get package.json version
 */
function getVersion(): string {
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
}

/**
 * Print help message and exit
 */
function printHelp(): void {
  console.log(`
arbiter - Hierarchical AI orchestration system

  Consult with the Arbiter, a wise overseer who commands a
  council of Orchestrators to tackle complex tasks. Each layer
  extends Claude's context, keeping the work on track. Bring
  a detailed markdown description of your requirements.

USAGE
  arbiter [options] [requirements-file]

OPTIONS
  -h, --help       Show this help message
  -v, --version    Show version number
  --resume         Resume from saved session (if <24h old)

EXAMPLES
  arbiter                   Start fresh session
  arbiter ./SPEC.md         Start with requirements file (skip in-game prompt)
  arbiter --resume          Resume previous session
`);
}

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
  process.stderr.write(`${JSON.stringify(sessionInfo)}\n`);
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

      // Show crash count if any crashes occurred during runtime
      if (state.crashCount > 0) {
        process.stderr.write(`\nSession had ${state.crashCount} crash(es) during runtime\n`);
      }
    }

    process.exit(exitCode);
  }

  // Note: SIGINT is handled by the TUI for confirmation dialogs
  // We only handle SIGTERM for graceful container shutdown
  process.on('SIGTERM', () => {
    shutdown(0);
  });

  try {
    // Parse CLI arguments
    const args = process.argv.slice(2);

    // Handle --help flag (early exit)
    if (args.includes('--help') || args.includes('-h')) {
      printHelp();
      process.exit(0);
    }

    // Handle --version flag (early exit)
    if (args.includes('--version') || args.includes('-v')) {
      console.log(getVersion());
      process.exit(0);
    }

    const shouldResume = args.includes('--resume');

    // Handle --resume flag
    let savedSession = null;
    if (shouldResume) {
      savedSession = loadSession();
      if (!savedSession) {
        console.warn('No valid session to resume (file missing or stale >24h). Starting fresh...');
      }
    }

    // Check for positional requirements file argument (first non-flag arg)
    const positionalArgs = args.filter(
      (arg) => !arg.startsWith('--') && !arg.startsWith('-'),
    );
    const cliRequirementsFile = positionalArgs[0] || null;

    let selectedCharacter: number;

    if (savedSession) {
      // Resume mode: skip intros, use default character
      selectedCharacter = 0;
    } else {
      // Normal mode: title screen, character select, forest intro

      // Show title screen first (any key continues)
      await showTitleScreen();

      // Check if Arbiter files should be added to .gitignore
      await checkGitignore();

      // Show character selection screen
      let selectResult = await showCharacterSelect();
      selectedCharacter = selectResult.character;

      // Show animated forest intro with selected character (unless skipped)
      // If player dies, go back to character select
      if (!selectResult.skipIntro) {
        let result = await showForestIntro(selectedCharacter);
        while (result === 'death') {
          selectResult = await showCharacterSelect();
          selectedCharacter = selectResult.character;
          if (selectResult.skipIntro) break;
          result = await showForestIntro(selectedCharacter);
        }
      }
    }

    // Create initial application state
    state = createInitialState();

    // Set requirements path if provided via CLI (interactive selection happens in TUI)
    state.requirementsPath = cliRequirementsFile;

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

    // Wire TUI exit to shutdown
    // When user confirms exit (presses 'y'), perform graceful shutdown
    tui.onExit(() => {
      shutdown(0);
    });

    // Start TUI (takes over terminal)
    tui.start();

    // Wait for requirements selection to complete before starting router
    tui.onRequirementsReady(async () => {
      if (!router) return;
      // Start router - either resume from saved session or start fresh
      if (savedSession) {
        await router.resumeFromSavedSession(savedSession);
      } else {
        await router.start();
      }
    });

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
