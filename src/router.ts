// Message Router - Core component managing sessions and routing messages
// Handles Arbiter and Orchestrator session lifecycle and message routing

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  Options,
} from "@anthropic-ai/claude-agent-sdk";

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

import {
  ARBITER_SYSTEM_PROMPT,
  createArbiterMcpServer,
  type ArbiterCallbacks,
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
};

// Maximum context window size (200K tokens)
const MAX_CONTEXT_TOKENS = 200000;

/**
 * Context tracking state for a single session
 *
 * THE FORMULA (tested to <0.5% accuracy across low and heavy tool use):
 *   total = baseline + max(cache_read + cache_create) - first(cache_read + cache_create) + sum(input) + sum(output)
 *
 * - baseline: from /context at session start (~18.5k typically)
 * - first(cache_read + cache_create): "cached system overhead" (~15.4k typically)
 * - max(cache_read + cache_create): high water mark of combined metric
 * - sum(input) + sum(output): accumulated non-cached I/O tokens
 *
 * Key insight: tracking (cache_read + cache_create) as a combined metric handles:
 * - Non-monotonic cache_read drops (cache expiry, session resume)
 * - cache_create being absorbed into future cache_read
 * - Variable caching states across sessions
 */
interface ContextTracker {
  baseline: number;           // From /context at startup
  seenMsgIds: Set<string>;    // Dedupe by message.id (NOT uuid)
  firstCombinedRC: number;    // First message's (cache_read + cache_create)
  maxCombinedRC: number;      // Max(cache_read + cache_create) seen
  sumInput: number;           // Sum of input_tokens
  sumOutput: number;          // Sum of output_tokens
}

function createContextTracker(baseline: number): ContextTracker {
  return {
    baseline,
    seenMsgIds: new Set(),
    firstCombinedRC: 0,
    maxCombinedRC: 0,
    sumInput: 0,
    sumOutput: 0,
  };
}

function getContextTokens(tracker: ContextTracker): number {
  // THE FORMULA: baseline + combined_growth + I/O
  const combinedGrowth = tracker.maxCombinedRC - tracker.firstCombinedRC;
  return tracker.baseline + combinedGrowth + tracker.sumInput + tracker.sumOutput;
}

function getContextPercent(tracker: ContextTracker): number {
  return (getContextTokens(tracker) / MAX_CONTEXT_TOKENS) * 100;
}

/**
 * Orchestrator session state - bundles all orchestrator-related data
 * This replaces the scattered properties that were previously on Router
 */
interface OrchestratorSession {
  id: string;                           // Unique ID (e.g., "orch-1234567890")
  number: number;                       // Roman numeral suffix (I, II, III...)
  sessionId: string;                    // SDK session ID for resuming
  query: AsyncGenerator<SDKMessage, void> | null;  // The active query generator
  abortController: AbortController;     // For killing the session
  contextTracker: ContextTracker;       // Context window tracking
  toolCallCount: number;                // Total tool calls made (was in Map, now here)
  queue: string[];                      // Queued messages awaiting flush to Arbiter
  lastActivityTime: number;             // For watchdog timeout detection
}

/**
 * Get baseline context by running /context with the same options as the agent.
 * This ensures the baseline reflects the agent's specific tools, system prompt, etc.
 */
async function getBaseline(options: Partial<Options>): Promise<number> {
  const q = query({
    prompt: '/context',
    options: {
      ...options,
      // Don't resume a session for baseline - we want fresh overhead
      resume: undefined,
    } as Options,
  });

  let baseline = 0;

  for await (const msg of q) {
    // /context output comes through as user message with <local-command-stdout>
    if (msg.type === 'user') {
      const content = (msg as { message?: { content?: string } }).message?.content;
      if (typeof content === 'string') {
        // Match: **Tokens:** 18.4k / 200.0k (9%)
        const match = content.match(/\*\*Tokens:\*\*\s*([0-9.]+)k/i);
        if (match) {
          baseline = Math.round(parseFloat(match[1]) * 1000);
        }
      }
    }
  }

  // Fallback to default if parsing failed
  return baseline || 18500;
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
 * Check if a message contains the @ARBITER: trigger
 * Returns true if the message starts with @ARBITER: (case insensitive)
 */
function hasArbiterTrigger(text: string): boolean {
  return /^@ARBITER:/i.test(text.trim());
}

/**
 * Strip the @ARBITER: prefix from a message for display
 * Only strips from the beginning of the message
 */
function stripTriggerTag(text: string): string {
  return text.trim().replace(/^@ARBITER:\s*/i, '');
}

/**
 * Determine the trigger type from a message
 * Returns 'handoff' if message contains HANDOFF keyword after @ARBITER:
 * Returns 'input' otherwise
 */
function getTriggerType(text: string): 'input' | 'handoff' {
  const stripped = stripTriggerTag(text);
  // Check if it's a handoff (contains HANDOFF keyword at start)
  if (/^HANDOFF\b/i.test(stripped)) {
    return 'handoff';
  }
  return 'input';
}

/**
 * Format queued messages and trigger message for the Arbiter
 * Uses «» delimiters with explicit labels
 *
 * @param queue - Array of queued messages (status updates)
 * @param triggerMessage - The message that triggered the flush (already stripped of @ARBITER:)
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

  // Context tracking for Arbiter session
  // Baseline is fetched via /context with the same options as the agent
  private arbiterContextTracker: ContextTracker | null = null;

  constructor(state: AppState, callbacks: RouterCallbacks) {
    this.state = state;
    this.callbacks = callbacks;
  }

  /**
   * Start the router - initializes the Arbiter session
   */
  async start(): Promise<void> {
    await this.startArbiterSession();
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

    // Create MCP server with Arbiter tools
    const mcpServer = createArbiterMcpServer(
      arbiterCallbacks,
      () => this.orchestratorCount
    );
    this.arbiterMcpServer = mcpServer;

    // Query options for the Arbiter session
    // Note: We use resume to continue sessions if we have a session ID
    const options: Options = {
      systemPrompt: ARBITER_SYSTEM_PROMPT,
      mcpServers: {
        "arbiter-tools": mcpServer,
      },
      abortController: this.arbiterAbortController,
      // Bypass permissions so MCP tools work without prompts
      permissionMode: 'bypassPermissions',
      // Arbiter's allowed tools: MCP tools + read-only exploration
      allowedTools: [
        'mcp__arbiter-tools__spawn_orchestrator',
        'mcp__arbiter-tools__disconnect_orchestrators',
        'Read',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',  // For Explore subagent only
      ],
      // Resume if we have an existing session
      ...(this.state.arbiterSessionId
        ? { resume: this.state.arbiterSessionId }
        : {}),
    };

    // Get baseline context for Arbiter with its specific options
    const arbiterBaseline = await getBaseline(options);
    this.arbiterContextTracker = createContextTracker(arbiterBaseline);

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
        // Context is now tracked from assistant messages via updateContextFromAssistant
        // This callback exists for hook compatibility but is no longer the source of truth
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

    // Create hooks for context management
    // The getContextPercent callback reads from our tracker for accurate context warnings
    const hooks = createOrchestratorHooks(
      orchestratorCallbacks,
      (_sessionId: string) =>
        this.currentOrchestratorSession
          ? getContextPercent(this.currentOrchestratorSession.contextTracker)
          : 0
    );

    // Query options for the Orchestrator session
    const options: Options = {
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
      hooks: hooks as Options["hooks"],
      abortController: abortController,
      // Bypass permissions so tools work without prompts
      permissionMode: 'bypassPermissions',
      // Orchestrators use all standard tools plus Task for subagents
      allowedTools: [
        "Read",
        "Write",
        "Edit",
        "Bash",
        "Glob",
        "Grep",
        "Task",
        "WebSearch",
        "WebFetch",
      ],
    };

    // Get baseline context for Orchestrator with its specific options
    const orchestratorBaseline = await getBaseline(options);

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
      contextTracker: createContextTracker(orchestratorBaseline),
      toolCallCount: 0,
      queue: [],
      lastActivityTime: Date.now(),
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
    // Note: In the SDK, we use resume with the session ID to continue
    const options: Options = {
      systemPrompt: ARBITER_SYSTEM_PROMPT,
      abortController: this.arbiterAbortController ?? new AbortController(),
      resume: this.state.arbiterSessionId ?? undefined,
      mcpServers: this.arbiterMcpServer ? {
        "arbiter-tools": this.arbiterMcpServer,
      } : undefined,
      // Bypass permissions so MCP tools work without prompts
      permissionMode: 'bypassPermissions',
      // Arbiter's allowed tools: MCP tools + read-only exploration
      allowedTools: [
        'mcp__arbiter-tools__spawn_orchestrator',
        'mcp__arbiter-tools__disconnect_orchestrators',
        'Read',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',  // For Explore subagent only
      ],
    };

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
    const options: Options = {
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
      abortController: this.currentOrchestratorSession.abortController,
      resume: this.currentOrchestratorSession.sessionId,
      // Bypass permissions so tools work without prompts
      permissionMode: 'bypassPermissions',
    };

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
   * Handle Orchestrator output - queue by default, flush on @ARBITER: trigger
   */
  private async handleOrchestratorOutput(text: string): Promise<void> {
    if (!this.currentOrchestratorSession) {
      console.error("No active orchestrator for output");
      return;
    }

    const session = this.currentOrchestratorSession;
    const orchNumber = session.number;
    const orchLabel = `Orchestrator ${toRoman(orchNumber)}`;
    const conjuringLabel = `Conjuring ${toRoman(orchNumber)}`;

    // Check for @ARBITER: trigger
    const hasTrigger = hasArbiterTrigger(text);

    // Strip trigger for display (user sees clean message)
    const displayText = hasTrigger ? stripTriggerTag(text) : text;

    // Log the message (use display text for cleaner logs)
    addMessage(this.state, orchLabel, displayText);

    // Log to debug (logbook)
    this.callbacks.onDebugLog?.({
      type: 'message',
      speaker: conjuringLabel,
      text: displayText,
    });

    // Notify callback for TUI display
    this.callbacks.onOrchestratorMessage(orchNumber, displayText);

    // Update activity timestamp for watchdog
    session.lastActivityTime = Date.now();

    if (hasTrigger) {
      // Determine trigger type (input vs handoff)
      const triggerType = getTriggerType(text);

      // Format the queue + trigger message for Arbiter
      const formattedMessage = formatQueueForArbiter(
        session.queue,
        displayText,  // Already stripped of @ARBITER:
        triggerType,
        orchNumber
      );

      // Log the flush for debugging
      this.callbacks.onDebugLog?.({
        type: 'system',
        text: `Flushing ${session.queue.length} queued messages + ${triggerType} to Arbiter`,
        details: { queueLength: session.queue.length, triggerType },
      });

      // Clear the queue
      session.queue = [];

      // Send formatted message to Arbiter
      await this.sendToArbiter(formattedMessage);
    } else {
      // Queue the message (raw text, not stripped - we want full context)
      session.queue.push(text);

      // Log the queue action for debugging
      this.callbacks.onDebugLog?.({
        type: 'system',
        text: `Queued message (${session.queue.length} total)`,
      });
    }
  }

  /**
   * Process messages from the Arbiter session
   */
  private async processArbiterMessages(
    generator: AsyncGenerator<SDKMessage, void>
  ): Promise<void> {
    this.isProcessing = true;

    try {
      try {
        for await (const message of generator) {
          await this.handleArbiterMessage(message);
        }
      } catch (error: any) {
        if (error?.name === 'AbortError') {
          // Silently ignore - this is expected during shutdown
          return;
        }
        throw error;
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
        }
        break;

      case "assistant":
        // Extract text content from the assistant message
        const assistantMessage = message as SDKAssistantMessage;

        // Track context from assistant messages (correct source)
        if (this.arbiterContextTracker) {
          this.updateContextFromAssistant(
            assistantMessage,
            this.arbiterContextTracker,
            'arbiter'
          );
        }

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
        // Result messages are logged for debugging but NOT used for context tracking
        // Context is tracked from assistant messages (see updateContextFromAssistant)
        break;
    }
  }

  /**
   * Process messages from an Orchestrator session
   */
  private async processOrchestratorMessages(
    generator: AsyncGenerator<SDKMessage, void>
  ): Promise<void> {
    try {
      for await (const message of generator) {
        await this.handleOrchestratorMessage(message);
      }

      // Stop waiting animation after Orchestrator response is complete
      this.callbacks.onWaitingStop?.();
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        // Silently ignore - this is expected during shutdown
        return;
      }
      console.error("Error processing Orchestrator messages:", error);
      throw error;
    }
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
        }
        break;

      case "assistant":
        // Extract text content from the assistant message
        const assistantMessage = message as SDKAssistantMessage;

        // Track context from assistant messages (correct source)
        if (this.currentOrchestratorSession) {
          this.updateContextFromAssistant(
            assistantMessage,
            this.currentOrchestratorSession.contextTracker,
            'orchestrator'
          );
        }

        const textContent = this.extractTextFromAssistantMessage(
          assistantMessage
        );
        if (textContent) {
          await this.handleOrchestratorOutput(textContent);
        }
        break;

      case "result":
        // Result messages are logged for debugging but NOT used for context tracking
        // Context is tracked from assistant messages (see updateContextFromAssistant)
        break;
    }
  }

  /**
   * Update context tracking from an assistant message
   *
   * THE FORMULA: baseline + max(cache_read + cache_create) - first(cache_read + cache_create)
   *
   * Key insight: tracking (cache_read + cache_create) as a combined metric handles:
   * - Non-monotonic cache_read drops (cache expiry, session resume)
   * - cache_create being absorbed into future cache_read
   * - Variable caching states across sessions
   *
   * Tested accuracy: ~0.9% error for both low-tool and heavy-tool scenarios
   *
   * Dedupes by message.id (NOT uuid - uuid is per streaming chunk)
   */
  private updateContextFromAssistant(
    message: SDKAssistantMessage,
    tracker: ContextTracker,
    agent: 'arbiter' | 'orchestrator'
  ): void {
    const msg = message.message as any;
    const usage = msg.usage;
    if (!usage) return;

    // CRITICAL: Dedupe by message.id, NOT uuid
    // uuid is per streaming chunk, message.id is per API call
    const msgId = msg.id;
    if (!msgId || tracker.seenMsgIds.has(msgId)) return;
    tracker.seenMsgIds.add(msgId);

    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheCreate = usage.cache_creation_input_tokens || 0;
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;

    // Combined metric: cache_read + cache_create
    const combinedRC = cacheRead + cacheCreate;

    // Capture first combined value as reference point
    if (tracker.firstCombinedRC === 0) {
      tracker.firstCombinedRC = combinedRC;
    }

    // Update tracking
    tracker.maxCombinedRC = Math.max(tracker.maxCombinedRC, combinedRC);
    tracker.sumInput += inputTokens;
    tracker.sumOutput += outputTokens;

    // Calculate context using THE FORMULA
    const tokens = getContextTokens(tracker);
    const pct = getContextPercent(tracker);
    const combinedGrowth = tracker.maxCombinedRC - tracker.firstCombinedRC;

    // Log for debugging
    this.callbacks.onDebugLog?.({
      type: 'system',
      agent,
      text: `Context: ${pct.toFixed(1)}% (${tokens.toLocaleString()} tokens)`,
      details: {
        messageId: msgId,
        uniqueApiCalls: tracker.seenMsgIds.size,
        formula: 'baseline + max(r+c) - first(r+c) + sum(i+o)',
        baseline: tracker.baseline,
        first_combined_rc: tracker.firstCombinedRC,
        max_combined_rc: tracker.maxCombinedRC,
        combined_growth: combinedGrowth,
        sum_input: tracker.sumInput,
        sum_output: tracker.sumOutput,
        this_message: { cache_read: cacheRead, cache_create: cacheCreate, combined: combinedRC, input: inputTokens, output: outputTokens },
        total_tokens: tokens,
        percent: pct,
      },
    });

    // Update state and notify callback
    if (agent === 'arbiter') {
      updateArbiterContext(this.state, pct);
      const orchPct = this.currentOrchestratorSession
        ? getContextPercent(this.currentOrchestratorSession.contextTracker)
        : null;
      this.callbacks.onContextUpdate(pct, orchPct);
    } else {
      updateOrchestratorContext(this.state, pct);
      this.callbacks.onContextUpdate(
        this.arbiterContextTracker ? getContextPercent(this.arbiterContextTracker) : 0,
        pct
      );
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
