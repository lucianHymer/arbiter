// Message Router - Core component managing sessions and routing messages
// Handles Arbiter and Orchestrator session lifecycle and message routing

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  Options,
  HookEvent,
  HookCallbackMatcher,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { saveSession, PersistedSession } from './session-persistence.js';
import { zodToJsonSchema } from "zod-to-json-schema";

// Helper for async delays
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry constants for crash recovery
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];  // 1s, 2s, 4s exponential backoff

// Arbiter's allowed tools: MCP tools + read-only exploration
const ARBITER_ALLOWED_TOOLS = [
  'mcp__arbiter-tools__spawn_orchestrator',
  'mcp__arbiter-tools__disconnect_orchestrators',
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',  // For Explore subagent only
] as const;

// Orchestrator's allowed tools: full tool access for work
const ORCHESTRATOR_ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'Task',
  'WebSearch',
  'WebFetch',
] as const;

import type { AppState, OrchestratorState } from "./state.js";
import {
  updateArbiterContext,
  updateOrchestratorContext,
  setCurrentOrchestrator,
  clearCurrentOrchestrator,
  setMode,
  addMessage,
  updateOrchestratorTool,
  toRoman,
} from "./state.js";

/**
 * Schema for Orchestrator structured output
 * Simple routing decision: does this message expect a response?
 */
const OrchestratorOutputSchema = z.object({
  expects_response: z.boolean().describe(
    "True if you need input from the Arbiter (questions, introductions, handoffs). False for status updates during heads-down work."
  ),
  message: z.string().describe("The message content"),
});

type OrchestratorOutput = z.infer<typeof OrchestratorOutputSchema>;

// Convert to JSON Schema for SDK
const orchestratorOutputJsonSchema = zodToJsonSchema(OrchestratorOutputSchema, {
  $refStrategy: "none",
});

import {
  ARBITER_SYSTEM_PROMPT,
  createArbiterMcpServer,
  createArbiterHooks,
  type ArbiterCallbacks,
  type ArbiterHooksCallbacks,
} from "./arbiter.js";

import {
  ORCHESTRATOR_SYSTEM_PROMPT,
  createOrchestratorHooks,
  type OrchestratorCallbacks,
} from "./orchestrator.js";

/**
 * Log entry types for debug logging
 */
export type DebugLogEntry = {
  type: 'message' | 'tool' | 'system' | 'sdk';
  speaker?: string;  // For messages: 'human', 'arbiter', 'Orchestrator I', etc.
  text: string;
  filtered?: boolean;  // True if this was filtered from main chat
  details?: any;
  agent?: 'arbiter' | 'orchestrator';  // For SDK messages
  sessionId?: string;  // SDK session ID
  messageType?: string;  // SDK message type (system, assistant, user, result)
};

/**
 * Callbacks for TUI integration
 * These are called by the router to notify the UI of state changes
 */
export type RouterCallbacks = {
  /** Called when the human sends a message (for immediate display before response) */
  onHumanMessage: (text: string) => void;
  /** Called when the Arbiter produces text output */
  onArbiterMessage: (text: string) => void;
  /** Called when an Orchestrator produces text output */
  onOrchestratorMessage: (orchestratorNumber: number, text: string) => void;
  /** Called when context usage is updated */
  onContextUpdate: (
    arbiterPercent: number,
    orchestratorPercent: number | null
  ) => void;
  /** Called when a tool is used by the Orchestrator */
  onToolUse: (tool: string, count: number) => void;
  /** Called when the routing mode changes */
  onModeChange: (mode: AppState["mode"]) => void;
  /** Called when waiting for a response starts */
  onWaitingStart?: (waitingFor: 'arbiter' | 'orchestrator') => void;
  /** Called when waiting for a response stops */
  onWaitingStop?: () => void;
  /** Called when an orchestrator is spawned (for tile scene demon spawning) */
  onOrchestratorSpawn?: (orchestratorNumber: number) => void;
  /** Called when orchestrators are disconnected (for tile scene demon removal) */
  onOrchestratorDisconnect?: () => void;
  /** Called for ALL events for debug logging (logbook) - includes filtered messages */
  onDebugLog?: (entry: DebugLogEntry) => void;
  /** Called when crash count changes (for TUI status display) */
  onCrashCountUpdate?: (count: number) => void;
};

// Maximum context window size (200K tokens)
const MAX_CONTEXT_TOKENS = 200000;

// Context polling interval (1 minute)
const CONTEXT_POLL_INTERVAL_MS = 60_000;

/**
 * Poll context usage by forking a session and running /context
 * Uses forkSession: true to avoid polluting the main conversation
 * Note: This does clutter resume history - no workaround found yet
 *
 * @param sessionId - The session ID to fork and check
 * @returns Context percentage (0-100) or null if polling failed
 */
async function pollContextForSession(sessionId: string): Promise<number | null> {
  try {
    const q = query({
      prompt: '/context',
      options: {
        resume: sessionId,
        forkSession: true,  // Fork to avoid polluting main session
        permissionMode: 'bypassPermissions',
      } as Options,
    });

    let percent: number | null = null;

    for await (const msg of q) {
      // /context output comes through as user message with the token info
      if (msg.type === 'user') {
        const content = (msg as { message?: { content?: string } }).message?.content;
        if (typeof content === 'string') {
          // Match: **Tokens:** 18.4k / 200.0k (9%)
          const match = content.match(/\*\*Tokens:\*\*\s*([0-9.]+)k\s*\/\s*200\.?0?k\s*\((\d+)%\)/i);
          if (match) {
            percent = parseInt(match[2], 10);
          }
        }
      }
    }

    return percent;
  } catch (error) {
    // Silently fail - context polling is best-effort
    return null;
  }
}

/**
 * Orchestrator session state - bundles all orchestrator-related data
 * This replaces the scattered properties that were previously on Router
 */
interface OrchestratorSession {
  id: string;                           // Unique ID (e.g., "orch-1234567890")
  number: number;                       // Roman numeral suffix (I, II, III...)
  sessionId: string;                    // SDK session ID for resuming
  query: ReturnType<typeof query> | null;  // The active query generator
  abortController: AbortController;     // For killing the session
  toolCallCount: number;                // Total tool calls made (was in Map, now here)
  queue: string[];                      // Queued messages awaiting flush to Arbiter
  lastActivityTime: number;             // For watchdog timeout detection
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;  // SDK hooks for tool tracking
}

/**
 * Formats an SDK message for debug logging
 * Returns a human-readable string representation of the message
 */
function formatSdkMessage(message: SDKMessage): string {
  switch (message.type) {
    case 'system': {
      const sysMsg = message as SDKSystemMessage;
      if (sysMsg.subtype === 'init') {
        return `session_id=${sysMsg.session_id}`;
      }
      return `subtype=${sysMsg.subtype}`;
    }

    case 'assistant': {
      const assistantMsg = message as SDKAssistantMessage;
      const content = assistantMsg.message.content;
      const parts: string[] = [];

      if (typeof content === 'string') {
        parts.push(`text: "${truncate(content, 100)}"`);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            const textBlock = block as { type: 'text'; text: string };
            parts.push(`text: "${truncate(textBlock.text, 100)}"`);
          } else if (block.type === 'tool_use') {
            const toolBlock = block as { type: 'tool_use'; id: string; name: string; input: any };
            const inputStr = JSON.stringify(toolBlock.input);
            parts.push(`tool_use: ${toolBlock.name}(${truncate(inputStr, 80)})`);
          } else if (block.type === 'tool_result') {
            const resultBlock = block as { type: 'tool_result'; tool_use_id: string; content: any };
            const contentStr = typeof resultBlock.content === 'string'
              ? resultBlock.content
              : JSON.stringify(resultBlock.content);
            parts.push(`tool_result: ${truncate(contentStr, 80)}`);
          } else {
            parts.push(`${block.type}: ...`);
          }
        }
      }

      return parts.join(' | ') || '(empty)';
    }

    case 'user': {
      const userMsg = message as any;
      const content = userMsg.message?.content;
      if (typeof content === 'string') {
        return `"${truncate(content, 100)}"`;
      } else if (Array.isArray(content)) {
        const types = content.map((b: any) => b.type).join(', ');
        return `[${types}]`;
      }
      return '(user message)';
    }

    case 'result': {
      const resultMsg = message as SDKResultMessage;
      if (resultMsg.subtype === 'success') {
        const usage = resultMsg.usage;
        const total = (usage.input_tokens || 0) +
          (usage.cache_read_input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0);
        const pct = ((total / MAX_CONTEXT_TOKENS) * 100).toFixed(1);
        return `success - tokens: ${total} (${pct}% context)`;
      } else {
        return `${resultMsg.subtype}`;
      }
    }

    default:
      return `(${message.type})`;
  }
}

/**
 * Truncates a string to a maximum length, adding ellipsis if needed
 */
function truncate(str: string, maxLength: number): string {
  // Remove newlines for cleaner display
  const clean = str.replace(/\n/g, '\\n');
  if (clean.length <= maxLength) return clean;
  return clean.substring(0, maxLength - 3) + '...';
}

/**
 * Format queued messages and trigger message for the Arbiter
 * Uses «» delimiters with explicit labels
 *
 * @param queue - Array of queued messages (status updates from expects_response: false)
 * @param triggerMessage - The message that triggered the flush (expects_response: true)
 * @param triggerType - 'input' for questions, 'handoff' for completion, 'human' for interjection
 * @param orchNumber - The orchestrator's number (for labeling)
 */
function formatQueueForArbiter(
  queue: string[],
  triggerMessage: string,
  triggerType: 'input' | 'handoff' | 'human',
  orchNumber: number
): string {
  const orchLabel = `Orchestrator ${toRoman(orchNumber)}`;
  const parts: string[] = [];

  // Add work log section if there are queued messages
  if (queue.length > 0) {
    parts.push(`«${orchLabel} - Work Log (no response needed)»`);
    for (const msg of queue) {
      parts.push(`• ${msg}`);
    }
    parts.push(''); // Empty line separator
  }

  // Add the trigger section based on type
  switch (triggerType) {
    case 'input':
      parts.push(`«${orchLabel} - Awaiting Input»`);
      break;
    case 'handoff':
      parts.push(`«${orchLabel} - Handoff»`);
      break;
    case 'human':
      parts.push(`«Human Interjection»`);
      break;
  }
  parts.push(triggerMessage);

  return parts.join('\n');
}

/**
 * Format a timeout message for the Arbiter
 */
function formatTimeoutForArbiter(
  queue: string[],
  orchNumber: number,
  idleMinutes: number
): string {
  const orchLabel = `Orchestrator ${toRoman(orchNumber)}`;
  const parts: string[] = [];

  // Add work log if there are queued messages
  if (queue.length > 0) {
    parts.push(`«${orchLabel} - Work Log (no response needed)»`);
    for (const msg of queue) {
      parts.push(`• ${msg}`);
    }
    parts.push('');
  }

  // Add timeout notice
  parts.push(`«${orchLabel} - TIMEOUT»`);
  parts.push(`No activity for ${idleMinutes} minutes. Session terminated.`);
  parts.push(`The Orchestrator may have encountered an error or become stuck.`);

  return parts.join('\n');
}

/**
 * Router class - Core component managing sessions and routing messages
 *
 * The router manages the Arbiter and Orchestrator sessions, routing messages
 * between them based on the current mode. It also tracks tool usage and
 * context percentages for display in the TUI.
 */
export class Router {
  private state: AppState;
  private callbacks: RouterCallbacks;

  // Session state
  private arbiterQuery: ReturnType<typeof query> | null = null;

  // Orchestrator session - bundles all orchestrator-related state
  private currentOrchestratorSession: OrchestratorSession | null = null;

  // Track orchestrator count for numbering (I, II, III...)
  private orchestratorCount = 0;

  // Track Arbiter tool calls
  private arbiterToolCallCount = 0;

  // Pending orchestrator spawn flag
  private pendingOrchestratorSpawn: boolean = false;
  private pendingOrchestratorNumber: number = 0;

  // Track if we're currently processing messages
  private isProcessing = false;

  // Abort controllers for graceful shutdown
  private arbiterAbortController: AbortController | null = null;

  // Watchdog timer for orchestrator inactivity detection
  private watchdogInterval: NodeJS.Timeout | null = null;

  // Store MCP server for Arbiter session resumption
  private arbiterMcpServer: any = null;

  // Store Arbiter hooks for session resumption
  private arbiterHooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> | null = null;

  // Context polling timer - polls /context once per minute via session forking
  private contextPollInterval: NodeJS.Timeout | null = null;

  // Track crash recovery attempts for TUI display
  private crashCount = 0;

  constructor(state: AppState, callbacks: RouterCallbacks) {
    this.state = state;
    this.callbacks = callbacks;
  }

  /**
   * Start the router - initializes the Arbiter session
   */
  async start(): Promise<void> {
    await this.startArbiterSession();
    this.startContextPolling();
  }

  /**
   * Start the context polling timer
   * Polls context for both Arbiter and Orchestrator (if active) once per minute
   */
  private startContextPolling(): void {
    // Clear any existing interval
    if (this.contextPollInterval) {
      clearInterval(this.contextPollInterval);
    }

    // Poll immediately on start, then every minute
    this.pollAllContexts();
    this.contextPollInterval = setInterval(() => {
      this.pollAllContexts();
    }, CONTEXT_POLL_INTERVAL_MS);
  }

  /**
   * Poll context for all active sessions
   * Forks sessions and runs /context to get accurate values
   */
  private async pollAllContexts(): Promise<void> {
    // Poll Arbiter context
    if (this.state.arbiterSessionId) {
      const arbiterPercent = await pollContextForSession(this.state.arbiterSessionId);
      if (arbiterPercent !== null) {
        updateArbiterContext(this.state, arbiterPercent);
        this.callbacks.onDebugLog?.({
          type: 'system',
          text: `Context poll: Arbiter at ${arbiterPercent}%`,
          agent: 'arbiter',
        });
      }
    }

    // Poll Orchestrator context if active
    let orchPercent: number | null = null;
    if (this.currentOrchestratorSession?.sessionId) {
      orchPercent = await pollContextForSession(this.currentOrchestratorSession.sessionId);
      if (orchPercent !== null) {
        updateOrchestratorContext(this.state, orchPercent);
        this.callbacks.onDebugLog?.({
          type: 'system',
          text: `Context poll: Orchestrator at ${orchPercent}%`,
          agent: 'orchestrator',
        });
      }
    }

    // Notify TUI with updated values from state
    this.callbacks.onContextUpdate(
      this.state.arbiterContextPercent,
      this.state.currentOrchestrator?.contextPercent ?? null
    );
  }

  /**
   * Resume from a previously saved session
   */
  async resumeFromSavedSession(saved: PersistedSession): Promise<void> {
    // Set arbiter session ID so startArbiterSession uses resume
    this.state.arbiterSessionId = saved.arbiterSessionId;

    // Start arbiter (it will use the session ID for resume)
    await this.startArbiterSession();

    // If there was an active orchestrator, resume it too
    if (saved.orchestratorSessionId && saved.orchestratorNumber) {
      await this.resumeOrchestratorSession(saved.orchestratorSessionId, saved.orchestratorNumber);
    }

    // Start context polling
    this.startContextPolling();
  }

  /**
   * Send a human message to the system
   * Routes based on current mode:
   * - human_to_arbiter: Send directly to Arbiter
   * - arbiter_to_orchestrator: Flush queue with human interjection framing
   */
  async sendHumanMessage(text: string): Promise<void> {
    // Log the human message and notify TUI immediately
    addMessage(this.state, "human", text);
    this.callbacks.onHumanMessage(text);

    if (this.state.mode === "arbiter_to_orchestrator" && this.currentOrchestratorSession) {
      const session = this.currentOrchestratorSession;

      // Human interjection during orchestrator work - flush queue with context
      const formattedMessage = formatQueueForArbiter(
        session.queue,
        text,
        'human',
        session.number
      );

      // Log the flush for debugging
      this.callbacks.onDebugLog?.({
        type: 'system',
        text: `Human interjection - flushing ${session.queue.length} queued messages`,
        details: { queueLength: session.queue.length },
      });

      // Clear the queue
      session.queue = [];

      // Send formatted message to Arbiter
      await this.sendToArbiter(formattedMessage);
    } else {
      // Direct to Arbiter (no orchestrator active or in human_to_arbiter mode)
      await this.sendToArbiter(text);
    }
  }

  /**
   * Clean shutdown of all sessions
   */
  async stop(): Promise<void> {
    // Stop context polling timer
    if (this.contextPollInterval) {
      clearInterval(this.contextPollInterval);
      this.contextPollInterval = null;
    }

    // Stop watchdog timer
    this.stopWatchdog();

    // Abort any running queries
    if (this.arbiterAbortController) {
      this.arbiterAbortController.abort();
      this.arbiterAbortController = null;
    }

    // Clean up orchestrator using the unified method
    this.cleanupOrchestrator();

    this.arbiterQuery = null;
  }

  /**
   * Clean up the current orchestrator session
   * Called when: spawning new orchestrator, disconnect, timeout, shutdown
   */
  private cleanupOrchestrator(): void {
    // Stop watchdog timer
    this.stopWatchdog();

    if (!this.currentOrchestratorSession) return;

    const session = this.currentOrchestratorSession;
    const orchLabel = `Orchestrator ${toRoman(session.number)}`;

    // 1. Log any orphaned queue messages (for debugging)
    if (session.queue.length > 0) {
      this.callbacks.onDebugLog?.({
        type: 'system',
        text: `${orchLabel} released with ${session.queue.length} undelivered messages`,
        details: { queuedMessages: session.queue },
      });
    }

    // 2. Abort the SDK session
    session.abortController.abort();

    // 3. Clear the working indicator (will be added later, safe to call now)
    // this.callbacks.onWorkingIndicator?.('orchestrator', null);

    // 4. Null out the session
    this.currentOrchestratorSession = null;

    // 5. Update shared state for TUI
    clearCurrentOrchestrator(this.state);

    // 6. Reset mode
    setMode(this.state, "human_to_arbiter");
    this.callbacks.onModeChange("human_to_arbiter");

    // 7. Update context display (no orchestrator)
    this.callbacks.onContextUpdate(this.state.arbiterContextPercent, null);

    // 8. Notify TUI about orchestrator disconnect (for tile scene)
    this.callbacks.onOrchestratorDisconnect?.();
  }

  /**
   * Start the watchdog timer for orchestrator inactivity detection
   */
  private startWatchdog(): void {
    // Clear any existing watchdog
    this.stopWatchdog();

    // Check every 30 seconds
    this.watchdogInterval = setInterval(() => {
      if (!this.currentOrchestratorSession) return;

      const idleMs = Date.now() - this.currentOrchestratorSession.lastActivityTime;
      const idleMinutes = Math.floor(idleMs / 60000);

      // 10 minute timeout
      if (idleMinutes >= 10) {
        this.handleOrchestratorTimeout(idleMinutes);
      }
    }, 30000);
  }

  /**
   * Stop the watchdog timer
   */
  private stopWatchdog(): void {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  /**
   * Handle orchestrator timeout - notify Arbiter and cleanup
   */
  private async handleOrchestratorTimeout(idleMinutes: number): Promise<void> {
    if (!this.currentOrchestratorSession) return;

    const session = this.currentOrchestratorSession;

    // Log the timeout
    this.callbacks.onDebugLog?.({
      type: 'system',
      text: `Orchestrator ${toRoman(session.number)} timed out after ${idleMinutes} minutes of inactivity`,
    });

    // Format timeout message for Arbiter
    const timeoutMessage = formatTimeoutForArbiter(
      session.queue,
      session.number,
      idleMinutes
    );

    // Cleanup the orchestrator (this also clears the queue)
    this.cleanupOrchestrator();

    // Stop the watchdog
    this.stopWatchdog();

    // Notify Arbiter about the timeout
    await this.sendToArbiter(timeoutMessage);
  }

  // ============================================
  // Private helper methods
  // ============================================

  /**
   * Creates options for Arbiter queries
   * Centralizes all Arbiter-specific options to avoid duplication
   */
  private createArbiterOptions(resumeSessionId?: string): Options {
    return {
      systemPrompt: ARBITER_SYSTEM_PROMPT,
      mcpServers: this.arbiterMcpServer ? { "arbiter-tools": this.arbiterMcpServer } : undefined,
      hooks: this.arbiterHooks ?? undefined,
      abortController: this.arbiterAbortController ?? new AbortController(),
      permissionMode: 'bypassPermissions',
      allowedTools: [...ARBITER_ALLOWED_TOOLS],
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    };
  }

  /**
   * Creates options for Orchestrator queries
   * Centralizes all Orchestrator-specific options to avoid duplication
   * @param hooks - Hooks object (from session or newly created)
   * @param abortController - AbortController (from session or newly created)
   * @param resumeSessionId - Optional session ID for resuming
   */
  private createOrchestratorOptions(
    hooks: object,
    abortController: AbortController,
    resumeSessionId?: string
  ): Options {
    return {
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
      hooks,
      abortController,
      permissionMode: 'bypassPermissions',
      allowedTools: [...ORCHESTRATOR_ALLOWED_TOOLS],
      outputFormat: {
        type: 'json_schema',
        schema: orchestratorOutputJsonSchema,
      },
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    };
  }

  /**
   * Creates and starts the Arbiter session with MCP tools
   */
  private async startArbiterSession(): Promise<void> {
    // Notify that we're waiting for Arbiter
    this.callbacks.onWaitingStart?.('arbiter');

    // Create abort controller for this session
    this.arbiterAbortController = new AbortController();

    // Create callbacks for MCP tools
    const arbiterCallbacks: ArbiterCallbacks = {
      onSpawnOrchestrator: (orchestratorNumber: number) => {
        // Store the number to spawn after current processing
        this.pendingOrchestratorSpawn = true;
        this.pendingOrchestratorNumber = orchestratorNumber;
      },
      onDisconnectOrchestrators: () => {
        this.cleanupOrchestrator();
      },
    };

    // Create callbacks for hooks (tool tracking)
    const arbiterHooksCallbacks: ArbiterHooksCallbacks = {
      onToolUse: (tool: string) => {
        this.arbiterToolCallCount++;
        this.callbacks.onToolUse(tool, this.arbiterToolCallCount);

        // Log tool use to debug
        this.callbacks.onDebugLog?.({
          type: 'tool',
          agent: 'arbiter',
          speaker: 'Arbiter',
          text: tool,
          details: { tool, count: this.arbiterToolCallCount },
        });
      },
    };

    // Create MCP server with Arbiter tools
    const mcpServer = createArbiterMcpServer(
      arbiterCallbacks,
      () => this.orchestratorCount
    );
    this.arbiterMcpServer = mcpServer;

    // Create hooks for tool tracking
    const hooks = createArbiterHooks(arbiterHooksCallbacks);
    this.arbiterHooks = hooks;

    // Create options using helper
    const options = this.createArbiterOptions(this.state.arbiterSessionId ?? undefined);

    // Note: The Arbiter session runs continuously.
    // We'll send messages to it and process responses in a loop.
    // Initial prompt to start the session - Arbiter awaits human input
    this.arbiterQuery = query({
      prompt: "Speak, mortal.",
      options,
    });

    // Process the initial response
    await this.processArbiterMessages(this.arbiterQuery);
  }

  /**
   * Creates and starts an Orchestrator session
   */
  private async startOrchestratorSession(number: number): Promise<void> {
    // Clean up any existing orchestrator before spawning new one (hard abort)
    this.cleanupOrchestrator();

    // Notify that we're waiting for Orchestrator
    this.callbacks.onWaitingStart?.('orchestrator');

    // Increment orchestrator count
    this.orchestratorCount = number;

    // Generate unique ID for this orchestrator
    const orchId = `orch-${Date.now()}`;

    // Create abort controller for this session
    const abortController = new AbortController();

    // Create callbacks for hooks
    const orchestratorCallbacks: OrchestratorCallbacks = {
      onContextUpdate: (_sessionId: string, _percent: number) => {
        // Context is now tracked via periodic polling (pollAllContexts)
        // This callback exists for hook compatibility but is unused
      },
      onToolUse: (tool: string) => {
        // Increment tool count on the session
        if (this.currentOrchestratorSession) {
          this.currentOrchestratorSession.toolCallCount++;
          const newCount = this.currentOrchestratorSession.toolCallCount;

          // Update state and notify callback
          updateOrchestratorTool(this.state, tool, newCount);
          this.callbacks.onToolUse(tool, newCount);

          // Log tool use to debug (logbook) with orchestrator context
          const conjuringLabel = `Conjuring ${toRoman(number)}`;
          this.callbacks.onDebugLog?.({
            type: 'tool',
            speaker: conjuringLabel,
            text: `[Tool] ${tool}`,
            details: { tool, count: newCount },
          });
        }
      },
    };

    // Create hooks for tool use tracking
    // Context is now tracked via polling, not hooks
    const hooks = createOrchestratorHooks(
      orchestratorCallbacks,
      // Context percent getter - returns state value (updated by polling)
      (_sessionId: string) => this.state.currentOrchestrator?.contextPercent || 0
    );

    // Create options using helper (no resume for initial session)
    const options = this.createOrchestratorOptions(hooks, abortController);

    // Create the orchestrator query
    const orchestratorQuery = query({
      prompt: "Introduce yourself and await instructions from the Arbiter.",
      options,
    });

    // Create the full OrchestratorSession object
    this.currentOrchestratorSession = {
      id: orchId,
      number,
      sessionId: "", // Will be set when we get the init message
      query: orchestratorQuery,
      abortController,
      toolCallCount: 0,
      queue: [],
      lastActivityTime: Date.now(),
      hooks,
    };

    // Set up TUI-facing orchestrator state before processing
    // We'll update the session ID when we get the init message
    setCurrentOrchestrator(this.state, {
      id: orchId,
      sessionId: "", // Will be set when we get the init message
      number,
    });

    // Switch mode
    setMode(this.state, "arbiter_to_orchestrator");
    this.callbacks.onModeChange("arbiter_to_orchestrator");

    // Notify about orchestrator spawn (for tile scene demon spawning)
    this.callbacks.onOrchestratorSpawn?.(number);

    // Update context display to show orchestrator (initially at 0%)
    this.callbacks.onContextUpdate(
      this.state.arbiterContextPercent,
      this.state.currentOrchestrator?.contextPercent ?? null
    );

    // Start watchdog timer
    this.startWatchdog();

    // Process orchestrator messages
    await this.processOrchestratorMessages(this.currentOrchestratorSession.query!);
  }

  /**
   * Resume an existing Orchestrator session
   * Similar to startOrchestratorSession but uses resume option and skips introduction
   */
  private async resumeOrchestratorSession(sessionId: string, number: number): Promise<void> {
    // Clean up any existing orchestrator before resuming
    this.cleanupOrchestrator();

    // Notify that we're waiting for Orchestrator
    this.callbacks.onWaitingStart?.('orchestrator');

    // Restore orchestrator count
    this.orchestratorCount = number;

    // Generate unique ID for this orchestrator
    const orchId = `orch-${Date.now()}`;

    // Create abort controller for this session
    const abortController = new AbortController();

    // Create callbacks for hooks
    const orchestratorCallbacks: OrchestratorCallbacks = {
      onContextUpdate: (_sessionId: string, _percent: number) => {
        // Context is now tracked via periodic polling (pollAllContexts)
        // This callback exists for hook compatibility but is unused
      },
      onToolUse: (tool: string) => {
        // Increment tool count on the session
        if (this.currentOrchestratorSession) {
          this.currentOrchestratorSession.toolCallCount++;
          const newCount = this.currentOrchestratorSession.toolCallCount;

          // Update state and notify callback
          updateOrchestratorTool(this.state, tool, newCount);
          this.callbacks.onToolUse(tool, newCount);

          // Log tool use to debug (logbook) with orchestrator context
          const conjuringLabel = `Conjuring ${toRoman(number)}`;
          this.callbacks.onDebugLog?.({
            type: 'tool',
            speaker: conjuringLabel,
            text: `[Tool] ${tool}`,
            details: { tool, count: newCount },
          });
        }
      },
    };

    // Create hooks for tool use tracking
    // Context is now tracked via polling, not hooks
    const hooks = createOrchestratorHooks(
      orchestratorCallbacks,
      // Context percent getter - returns state value (updated by polling)
      (_sessionId: string) => this.state.currentOrchestrator?.contextPercent || 0
    );

    // Create options using helper with resume
    const options = this.createOrchestratorOptions(hooks, abortController, sessionId);

    // Create the orchestrator query with a continuation prompt (not introduction)
    const orchestratorQuery = query({
      prompt: "[System: Session resumed. Continue where you left off.]",
      options,
    });

    // Create the full OrchestratorSession object
    // Note: sessionId is already known from the saved session
    this.currentOrchestratorSession = {
      id: orchId,
      number,
      sessionId: sessionId,  // Already known, don't set to empty string
      query: orchestratorQuery,
      abortController,
      toolCallCount: 0,
      queue: [],
      lastActivityTime: Date.now(),
      hooks,
    };

    // Set up TUI-facing orchestrator state
    setCurrentOrchestrator(this.state, {
      id: orchId,
      sessionId: sessionId,
      number,
    });

    // Switch mode
    setMode(this.state, "arbiter_to_orchestrator");
    this.callbacks.onModeChange("arbiter_to_orchestrator");

    // Notify about orchestrator spawn (for tile scene demon spawning)
    this.callbacks.onOrchestratorSpawn?.(number);

    // Update context display to show orchestrator (initially at 0%)
    this.callbacks.onContextUpdate(
      this.state.arbiterContextPercent,
      this.state.currentOrchestrator?.contextPercent ?? null
    );

    // Start watchdog timer
    this.startWatchdog();

    // Process orchestrator messages
    await this.processOrchestratorMessages(this.currentOrchestratorSession.query!);
  }

  /**
   * Send a message to the Arbiter
   */
  private async sendToArbiter(text: string): Promise<void> {
    if (!this.arbiterQuery) {
      console.error("Arbiter session not started");
      return;
    }

    // Notify that we're waiting for Arbiter
    this.callbacks.onWaitingStart?.('arbiter');

    // Create a new query to continue the conversation
    const options = this.createArbiterOptions(this.state.arbiterSessionId ?? undefined);

    this.arbiterQuery = query({
      prompt: text,
      options,
    });

    await this.processArbiterMessages(this.arbiterQuery);
  }

  /**
   * Send a message to the current Orchestrator
   */
  private async sendToOrchestrator(text: string): Promise<void> {
    if (!this.currentOrchestratorSession) {
      console.error("No active orchestrator session");
      return;
    }

    // Notify that we're waiting for Orchestrator
    this.callbacks.onWaitingStart?.('orchestrator');

    // Create a new query to continue the conversation
    const options = this.createOrchestratorOptions(
      this.currentOrchestratorSession.hooks,
      this.currentOrchestratorSession.abortController,
      this.currentOrchestratorSession.sessionId
    );

    const newQuery = query({
      prompt: text,
      options,
    });

    // Update the session's query
    this.currentOrchestratorSession.query = newQuery;

    await this.processOrchestratorMessages(newQuery);
  }

  /**
   * Handle Arbiter output based on mode
   * In arbiter_to_orchestrator mode, forward to Orchestrator
   * In human_to_arbiter mode, display to human
   */
  private async handleArbiterOutput(text: string): Promise<void> {
    // Log the message (always, for history/debug)
    addMessage(this.state, "arbiter", text);

    // Log to debug (logbook)
    this.callbacks.onDebugLog?.({
      type: 'message',
      speaker: 'arbiter',
      text,
    });

    this.callbacks.onArbiterMessage(text);

    // If we're in orchestrator mode, forward to the orchestrator
    if (
      this.state.mode === "arbiter_to_orchestrator" &&
      this.state.currentOrchestrator
    ) {
      await this.sendToOrchestrator(text);
    }
  }

  /**
   * Handle Orchestrator output - route based on expects_response field
   * expects_response: true → forward to Arbiter (questions, introductions, handoffs)
   * expects_response: false → queue for later (status updates during work)
   */
  private async handleOrchestratorOutput(output: OrchestratorOutput): Promise<void> {
    if (!this.currentOrchestratorSession) {
      console.error("No active orchestrator for output");
      return;
    }

    const session = this.currentOrchestratorSession;
    const orchNumber = session.number;
    const orchLabel = `Orchestrator ${toRoman(orchNumber)}`;
    const conjuringLabel = `Conjuring ${toRoman(orchNumber)}`;
    const { expects_response, message } = output;

    // Log the message
    addMessage(this.state, orchLabel, message);

    // Log to debug (logbook)
    this.callbacks.onDebugLog?.({
      type: 'message',
      speaker: conjuringLabel,
      text: message,
      details: { expects_response },
    });

    // Notify callback for TUI display
    this.callbacks.onOrchestratorMessage(orchNumber, message);

    // Update activity timestamp for watchdog
    session.lastActivityTime = Date.now();

    if (expects_response) {
      // Forward to Arbiter - determine if this looks like a handoff
      const isHandoff = /^HANDOFF\b/i.test(message.trim());
      const triggerType = isHandoff ? 'handoff' : 'input';

      // Format the queue + message for Arbiter
      const formattedMessage = formatQueueForArbiter(
        session.queue,
        message,
        triggerType,
        orchNumber
      );

      // Log the flush for debugging
      this.callbacks.onDebugLog?.({
        type: 'system',
        text: `Forwarding to Arbiter (${triggerType}) with ${session.queue.length} queued messages`,
        details: { queueLength: session.queue.length, triggerType, expects_response },
      });

      // Clear the queue
      session.queue = [];

      // Send formatted message to Arbiter
      await this.sendToArbiter(formattedMessage);
    } else {
      // Queue the message for later
      session.queue.push(message);

      // Log the queue action for debugging
      this.callbacks.onDebugLog?.({
        type: 'system',
        text: `Queued message (${session.queue.length} total)`,
        details: { expects_response },
      });
    }
  }

  /**
   * Process messages from the Arbiter session with retry logic for crash recovery
   */
  private async processArbiterMessages(
    generator: ReturnType<typeof query>
  ): Promise<void> {
    this.isProcessing = true;
    let retries = 0;
    let currentGenerator: ReturnType<typeof query> = generator;

    try {
      while (true) {
        try {
          for await (const message of currentGenerator) {
            // Reset retries on each successful message
            retries = 0;
            await this.handleArbiterMessage(message);
          }
          // Successfully finished processing
          break;
        } catch (error: any) {
          if (error?.name === 'AbortError') {
            // Silently ignore - this is expected during shutdown
            return;
          }

          // Increment crash count and notify TUI
          this.crashCount++;
          this.callbacks.onCrashCountUpdate?.(this.crashCount);

          // Log the error
          this.callbacks.onDebugLog?.({
            type: 'system',
            text: `Arbiter crash #${this.crashCount}, retry ${retries + 1}/${MAX_RETRIES}`,
            details: { error: error?.message || String(error) },
          });

          // Check if we've exceeded max retries
          if (retries >= MAX_RETRIES) {
            throw error;
          }

          // Wait before retrying with exponential backoff
          await sleep(RETRY_DELAYS[retries]);
          retries++;

          // Create a new resume query
          const options = this.createArbiterOptions(this.state.arbiterSessionId ?? undefined);

          currentGenerator = query({
            prompt: "[System: Session resumed after error. Continue where you left off.]",
            options,
          });
          this.arbiterQuery = currentGenerator;
        }
      }

      // Stop waiting animation after Arbiter response is complete
      this.callbacks.onWaitingStop?.();

      // Check if we need to spawn an orchestrator
      if (this.pendingOrchestratorSpawn) {
        const number = this.pendingOrchestratorNumber;
        this.pendingOrchestratorSpawn = false;
        this.pendingOrchestratorNumber = 0;

        await this.startOrchestratorSession(number);
      }
    } catch (error) {
      console.error("Error processing Arbiter messages:", error);
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Handle a single message from the Arbiter
   */
  private async handleArbiterMessage(message: SDKMessage): Promise<void> {
    // Log ALL raw SDK messages for debug
    this.callbacks.onDebugLog?.({
      type: 'sdk',
      agent: 'arbiter',
      messageType: message.type,
      sessionId: this.state.arbiterSessionId ?? undefined,
      text: formatSdkMessage(message),
      details: message,
    });

    switch (message.type) {
      case "system":
        if ((message as SDKSystemMessage).subtype === "init") {
          // Capture session ID
          this.state.arbiterSessionId = message.session_id;

          // Save session for crash recovery
          saveSession(
            message.session_id,
            this.currentOrchestratorSession?.sessionId ?? null,
            this.currentOrchestratorSession?.number ?? null
          );
        }
        break;

      case "assistant":
        // Extract text content from the assistant message
        const assistantMessage = message as SDKAssistantMessage;

        // Track tool use from Arbiter (MCP tools like spawn_orchestrator)
        this.trackToolUseFromAssistant(assistantMessage, 'arbiter');

        const textContent = this.extractTextFromAssistantMessage(
          assistantMessage
        );
        if (textContent) {
          await this.handleArbiterOutput(textContent);
        }
        break;

      case "result":
        // Result messages logged for debugging
        // Context is tracked via periodic polling, not per-message
        break;
    }
  }

  /**
   * Process messages from an Orchestrator session with retry logic for crash recovery
   */
  private async processOrchestratorMessages(
    generator: ReturnType<typeof query>
  ): Promise<void> {
    let retries = 0;
    let currentGenerator: ReturnType<typeof query> = generator;

    while (true) {
      try {
        for await (const message of currentGenerator) {
          // Reset retries on each successful message
          retries = 0;
          await this.handleOrchestratorMessage(message);
        }
        // Successfully finished processing
        break;
      } catch (error: any) {
        if (error?.name === 'AbortError') {
          // Silently ignore - this is expected during shutdown
          return;
        }

        // Increment crash count and notify TUI
        this.crashCount++;
        this.callbacks.onCrashCountUpdate?.(this.crashCount);

        // Log the error
        this.callbacks.onDebugLog?.({
          type: 'system',
          text: `Orchestrator crash #${this.crashCount}, retry ${retries + 1}/${MAX_RETRIES}`,
          details: { error: error?.message || String(error) },
        });

        // Check if we've exceeded max retries
        if (retries >= MAX_RETRIES) {
          // Orchestrator can't be resumed - cleanup and return (don't crash the whole app)
          console.error("Orchestrator exceeded max retries, cleaning up:", error);
          this.cleanupOrchestrator();
          return;
        }

        // Make sure we still have an active session
        if (!this.currentOrchestratorSession) {
          return;
        }

        // Wait before retrying with exponential backoff
        await sleep(RETRY_DELAYS[retries]);
        retries++;

        // Create a new resume query
        const options = this.createOrchestratorOptions(
          this.currentOrchestratorSession.hooks,
          this.currentOrchestratorSession.abortController,
          this.currentOrchestratorSession.sessionId
        );

        currentGenerator = query({
          prompt: "[System: Session resumed after error. Continue where you left off.]",
          options,
        });
        this.currentOrchestratorSession.query = currentGenerator;
      }
    }

    // Stop waiting animation after Orchestrator response is complete
    this.callbacks.onWaitingStop?.();
  }

  /**
   * Handle a single message from an Orchestrator
   */
  private async handleOrchestratorMessage(message: SDKMessage): Promise<void> {
    // Log ALL raw SDK messages for debug
    const orchSessionId = this.currentOrchestratorSession?.sessionId;
    this.callbacks.onDebugLog?.({
      type: 'sdk',
      agent: 'orchestrator',
      messageType: message.type,
      sessionId: orchSessionId ?? undefined,
      text: formatSdkMessage(message),
      details: message,
    });

    switch (message.type) {
      case "system":
        if ((message as SDKSystemMessage).subtype === "init") {
          // Update orchestrator session ID on both the session and TUI state
          if (this.currentOrchestratorSession) {
            this.currentOrchestratorSession.sessionId = message.session_id;
          }
          if (this.state.currentOrchestrator) {
            this.state.currentOrchestrator.sessionId = message.session_id;
          }

          // Save session for crash recovery
          saveSession(
            this.state.arbiterSessionId!,
            message.session_id,
            this.currentOrchestratorSession?.number ?? null
          );
        }
        break;

      case "assistant":
        // Note: Context is tracked via periodic polling, not per-message
        // We don't extract text from assistant messages - output comes from structured_output
        break;

      case "result":
        // Handle structured output from successful result messages
        const resultMessage = message as SDKResultMessage;
        if (resultMessage.subtype === 'success') {
          const structuredOutput = (resultMessage as any).structured_output;
          if (structuredOutput) {
            // Parse and validate the structured output
            const parsed = OrchestratorOutputSchema.safeParse(structuredOutput);
            if (parsed.success) {
              await this.handleOrchestratorOutput(parsed.data);
            } else {
              // Log parsing error but don't crash
              this.callbacks.onDebugLog?.({
                type: 'system',
                text: `Failed to parse orchestrator output: ${parsed.error.message}`,
                details: { structuredOutput, error: parsed.error },
              });
            }
          }
        }
        break;
    }
  }

  /**
   * Extract text content from an assistant message
   * The message.message.content can be a string or an array of content blocks
   */
  private extractTextFromAssistantMessage(
    message: SDKAssistantMessage
  ): string | null {
    const content = message.message.content;

    // Handle string content
    if (typeof content === "string") {
      return content;
    }

    // Handle array of content blocks
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      for (const block of content) {
        if (block.type === "text") {
          textParts.push((block as { type: "text"; text: string }).text);
        }
        // We ignore tool_use blocks here as they're handled separately
      }
      return textParts.length > 0 ? textParts.join("\n") : null;
    }

    return null;
  }

  /**
   * Track tool_use blocks from an assistant message
   * Used for both Arbiter and Orchestrator tool tracking
   */
  private trackToolUseFromAssistant(
    message: SDKAssistantMessage,
    agent: 'arbiter' | 'orchestrator'
  ): void {
    const content = message.message.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === 'tool_use') {
        const toolBlock = block as { type: 'tool_use'; id: string; name: string; input: any };
        const toolName = toolBlock.name;

        // Log tool use for this agent
        const speaker = agent === 'arbiter' ? 'Arbiter' : `Conjuring ${toRoman(this.state.currentOrchestrator?.number ?? 1)}`;
        this.callbacks.onDebugLog?.({
          type: 'tool',
          speaker,
          text: `[Tool] ${toolName}`,
          details: { tool: toolName, input: toolBlock.input },
        });
      }
    }
  }
}
