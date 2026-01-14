/**
 * Router callbacks factory module
 *
 * Extracts the router callback creation logic from tui-termkit.ts
 * into a separate, testable module.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DebugLogEntry, RouterCallbacks } from '../router.js';
import type { ArbiterIntent } from '../state.js';
import { DEBUG_LOG_PATH } from './constants.js';
import type { Sprite } from './sprite.js';
import type { Speaker } from './types.js';

/**
 * Internal TUI state required for callbacks
 * This is a subset of the full TUIState interface
 */
export interface CallbackTUIState {
  arbiterContextPercent: number;
  orchestratorContextPercent: number | null;
  currentTool: string | null;
  toolCallCount: number;
  lastToolTime: number;
  recentTools: string[];
  toolCountSinceLastMessage: number;
  showToolIndicator: boolean;
  arbiterHasSpoken: boolean;
  waitingFor: 'none' | 'arbiter' | 'orchestrator';
}

/**
 * Dependencies required by the router callbacks
 */
export interface CallbackDeps {
  // State accessors
  getState: () => CallbackTUIState;

  // Entrance state
  isEntranceComplete: () => boolean;
  getPendingArbiterMessage: () => string | null;
  setPendingArbiterMessage: (msg: string | null) => void;

  // Sprites
  humanSprite: Sprite;
  arbiterSprite: Sprite;
  demons: Sprite[];
  smokeSprite: Sprite;

  // Actions
  addMessage: (speaker: Speaker, text: string, orchestratorNumber?: number) => void;
  drawTiles: (force?: boolean) => void;
  drawChat: (force?: boolean) => void;
  drawContext: (force?: boolean) => void;

  // Sequences
  queueDemonSpawn: (index: number) => void;
  dismissAllOrchestrators: () => Promise<void>;
}

/**
 * Creates router callbacks that integrate with the TUI
 *
 * @param deps - Dependencies required by the callbacks
 * @returns RouterCallbacks object for use with the Router
 */
export function createRouterCallbacks(deps: CallbackDeps): RouterCallbacks {
  const {
    getState,
    isEntranceComplete,
    setPendingArbiterMessage,
    arbiterSprite,
    demons,
    smokeSprite,
    addMessage,
    drawTiles,
    drawChat,
    drawContext,
    queueDemonSpawn,
    dismissAllOrchestrators,
  } = deps;

  return {
    onHumanMessage: (text: string) => {
      addMessage('human', text);
      // Hide tool indicator on message
      const state = getState();
      state.showToolIndicator = false;
      state.recentTools = [];
      state.toolCountSinceLastMessage = 0;
    },

    onArbiterMessage: (text: string) => {
      // If entrance animation isn't complete, queue the message
      if (!isEntranceComplete()) {
        setPendingArbiterMessage(text);
      } else {
        addMessage('arbiter', text);
      }
      // Unlock input now that arbiter has spoken
      const state = getState();
      state.arbiterHasSpoken = true;
      // Hide tool indicator on message
      state.showToolIndicator = false;
      state.recentTools = [];
      state.toolCountSinceLastMessage = 0;
    },

    onOrchestratorMessage: (orchestratorNumber: number, text: string) => {
      addMessage('orchestrator', text, orchestratorNumber);
      // Hide tool indicator on message
      const state = getState();
      state.showToolIndicator = false;
      state.recentTools = [];
      state.toolCountSinceLastMessage = 0;
    },

    onContextUpdate: (arbiterPercent: number, orchestratorPercent: number | null) => {
      const state = getState();
      state.arbiterContextPercent = arbiterPercent;
      state.orchestratorContextPercent = orchestratorPercent;
      drawContext();
    },

    onToolUse: (tool: string, count: number) => {
      const state = getState();
      state.currentTool = tool;
      state.toolCallCount = count;
      state.lastToolTime = Date.now();

      // Update tool indicator state
      state.toolCountSinceLastMessage++;
      state.showToolIndicator = true;
      // Keep last 2 tools
      if (
        state.recentTools.length === 0 ||
        state.recentTools[state.recentTools.length - 1] !== tool
      ) {
        state.recentTools.push(tool);
        if (state.recentTools.length > 2) {
          state.recentTools.shift();
        }
      }

      drawContext();
      drawChat(); // Also redraw chat for tool indicator
    },

    onArbiterIntent: (intent: ArbiterIntent) => {
      // Handle visual feedback based on intent
      // For now, just handle release - demon spawning is done via onOrchestratorSpawn
      if (intent === 'release_orchestrators') {
        dismissAllOrchestrators(); // Fire and forget
      }
      // Future: Could animate arbiter walking to different positions based on intent
      // address_human -> walk toward human
      // address_orchestrator/summon_orchestrator -> walk toward cauldron
    },

    onWaitingStart: (waitingFor: 'arbiter' | 'orchestrator') => {
      const state = getState();
      // Always track waiting state (so chat shows "is working..." after entrance)
      state.waitingFor = waitingFor;

      // Skip animations during entrance sequence - don't want arbiter hopping early
      if (!isEntranceComplete()) return;

      // Hop for 3 seconds (6 hops)
      const target = waitingFor === 'arbiter' ? arbiterSprite : demons[0];
      if (target) {
        target.hop(6); // Fire and forget
      }

      // Start cauldron bubbling
      smokeSprite.startBubbling();

      drawTiles(true);
      drawChat(true);
    },

    onWaitingStop: () => {
      const state = getState();
      state.waitingFor = 'none';

      // Stop any ongoing animations
      arbiterSprite.stopAnimation();
      for (const d of demons) d.stopAnimation();

      // Stop bubbling
      smokeSprite.stopBubbling();

      drawTiles(true);
      drawChat(true);
    },

    onOrchestratorSpawn: (orchestratorNumber: number) => {
      // orchestratorNumber is 1-indexed, convert to 0-indexed for demons array
      const demonIndex = orchestratorNumber - 1;
      queueDemonSpawn(demonIndex);
    },

    onOrchestratorDisconnect: () => {
      // Run dismiss sequence (fire and forget)
      dismissAllOrchestrators();
      // Also clear orchestrator UI state
      const state = getState();
      state.orchestratorContextPercent = null;
      state.currentTool = null;
      state.toolCallCount = 0;
      drawContext();
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
      } catch (_err) {
        // Silently ignore write errors
      }
    },
  };
}
