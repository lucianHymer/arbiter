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
 * THE FORMULA (tested to ~0.6% accuracy):
 *   total = baseline + (max(cache_read) - first(cache_read)) + last(cache_create)
 *
 * - baseline: from /context at session start
 * - cache_read growth: how much new content has been cached
 * - last(cache_create): pending content not yet in cache
 */
interface ContextTracker {
  baseline: number;           // From /context at startup
  seenMsgIds: Set<string>;    // Dedupe by message.id (NOT uuid)
  firstCacheRead: number;     // Reference point for growth calculation
  maxCacheRead: number;       // Highest cache_read seen
  lastCacheCreate: number;    // Most recent cache_create (pending content)
}

function createContextTracker(baseline: number): ContextTracker {
  return {
    baseline,
    seenMsgIds: new Set(),
    firstCacheRead: 0,
    maxCacheRead: 0,
    lastCacheCreate: 0,
  };
}

function getContextTokens(tracker: ContextTracker): number {
  // THE FORMULA: baseline + message_growth + pending_content
  const cacheGrowth = tracker.maxCacheRead - tracker.firstCacheRead;
  return tracker.baseline + cacheGrowth + tracker.lastCacheCreate;
}

function getContextPercent(tracker: ContextTracker): number {
  return (getContextTokens(tracker) / MAX_CONTEXT_TOKENS) * 100;
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
  private orchestratorQuery: ReturnType<typeof query> | null = null;

  // Track orchestrator count for numbering (I, II, III...)
  private orchestratorCount = 0;

  // Track tool call counts per orchestrator
  private toolCallCounts: Map<string, number> = new Map();

  // Pending orchestrator spawn flag
  private pendingOrchestratorSpawn: boolean = false;
  private pendingOrchestratorNumber: number = 0;

  // Track if we're currently processing messages
  private isProcessing = false;

  // Abort controllers for graceful shutdown
  private arbiterAbortController: AbortController | null = null;
  private orchestratorAbortController: AbortController | null = null;

  // Store MCP server for Arbiter session resumption
  private arbiterMcpServer: any = null;

  // Context tracking - separate tracker per session
  // Baseline is fetched via /context with the same options as the agent
  private arbiterContextTracker: ContextTracker | null = null;
  private orchestratorContextTracker: ContextTracker | null = null;

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
   * - arbiter_to_orchestrator: Inject to Arbiter tagged as "Human:"
   */
  async sendHumanMessage(text: string): Promise<void> {
    // Log the human message and notify TUI immediately
    addMessage(this.state, "human", text);
    this.callbacks.onHumanMessage(text);

    if (this.state.mode === "human_to_arbiter") {
      // Send directly to Arbiter
      await this.sendToArbiter(text);
    } else {
      // Inject to Arbiter
      await this.sendToArbiter(text);
    }
  }

  /**
   * Clean shutdown of all sessions
   */
  async stop(): Promise<void> {
    // Abort any running queries
    if (this.arbiterAbortController) {
      this.arbiterAbortController.abort();
      this.arbiterAbortController = null;
    }

    if (this.orchestratorAbortController) {
      this.orchestratorAbortController.abort();
      this.orchestratorAbortController = null;
    }

    this.arbiterQuery = null;
    this.orchestratorQuery = null;
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
        // Clean up current orchestrator
        if (this.orchestratorAbortController) {
          this.orchestratorAbortController.abort();
          this.orchestratorAbortController = null;
        }
        this.orchestratorQuery = null;
        this.orchestratorContextTracker = null;  // Clear context tracker
        clearCurrentOrchestrator(this.state);

        // Switch mode
        setMode(this.state, "human_to_arbiter");
        this.callbacks.onModeChange("human_to_arbiter");

        // Update context display (no orchestrator)
        this.callbacks.onContextUpdate(this.state.arbiterContextPercent, null);

        // Notify about orchestrator disconnect (for tile scene demon removal)
        this.callbacks.onOrchestratorDisconnect?.();
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
    // Notify that we're waiting for Orchestrator
    this.callbacks.onWaitingStart?.('orchestrator');

    // Increment orchestrator count
    this.orchestratorCount = number;

    // Create abort controller for this session
    this.orchestratorAbortController = new AbortController();

    // Generate unique ID for this orchestrator
    const orchId = `orch-${Date.now()}`;

    // Create callbacks for hooks
    const orchestratorCallbacks: OrchestratorCallbacks = {
      onContextUpdate: (_sessionId: string, _percent: number) => {
        // Context is now tracked from assistant messages via updateContextFromAssistant
        // This callback exists for hook compatibility but is no longer the source of truth
      },
      onToolUse: (tool: string) => {
        // Increment tool count
        const currentCount = this.toolCallCounts.get(orchId) || 0;
        const newCount = currentCount + 1;
        this.toolCallCounts.set(orchId, newCount);

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
      },
    };

    // Create hooks for context management
    // The getContextPercent callback reads from our tracker for accurate context warnings
    const hooks = createOrchestratorHooks(
      orchestratorCallbacks,
      (_sessionId: string) =>
        this.orchestratorContextTracker
          ? getContextPercent(this.orchestratorContextTracker)
          : 0
    );

    // Query options for the Orchestrator session
    const options: Options = {
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
      hooks: hooks as Options["hooks"],
      abortController: this.orchestratorAbortController,
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
    this.orchestratorContextTracker = createContextTracker(orchestratorBaseline);

    // Create the orchestrator session - orchestrator introduces themselves
    this.orchestratorQuery = query({
      prompt: "Introduce yourself and await instructions from the Arbiter.",
      options,
    });

    // Set up orchestrator state before processing
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

    // Process orchestrator messages
    await this.processOrchestratorMessages(this.orchestratorQuery);
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
    if (!this.state.currentOrchestrator) {
      console.error("No active orchestrator");
      return;
    }

    // Notify that we're waiting for Orchestrator
    this.callbacks.onWaitingStart?.('orchestrator');

    // Create a new query to continue the conversation
    const options: Options = {
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
      abortController:
        this.orchestratorAbortController ?? new AbortController(),
      resume: this.state.currentOrchestrator.sessionId,
      // Bypass permissions so tools work without prompts
      permissionMode: 'bypassPermissions',
    };

    this.orchestratorQuery = query({
      prompt: text,
      options,
    });

    await this.processOrchestratorMessages(this.orchestratorQuery);
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
   * Handle Orchestrator output - routes to Arbiter with tag
   */
  private async handleOrchestratorOutput(text: string): Promise<void> {
    if (!this.state.currentOrchestrator) {
      console.error("No active orchestrator for output");
      return;
    }

    const orchNumber = this.state.currentOrchestrator.number;
    const orchLabel = `Orchestrator ${toRoman(orchNumber)}`;
    const conjuringLabel = `Conjuring ${toRoman(orchNumber)}`;

    // Log the message
    addMessage(this.state, orchLabel, text);

    // Log to debug (logbook)
    this.callbacks.onDebugLog?.({
      type: 'message',
      speaker: conjuringLabel,
      text,
    });

    // Notify callback
    this.callbacks.onOrchestratorMessage(orchNumber, text);

    // Route to Arbiter
    await this.sendToArbiter(text);
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
    const orchSessionId = this.state.currentOrchestrator?.sessionId;
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
          // Update orchestrator session ID
          if (this.state.currentOrchestrator) {
            this.state.currentOrchestrator.sessionId = message.session_id;
          }
        }
        break;

      case "assistant":
        // Extract text content from the assistant message
        const assistantMessage = message as SDKAssistantMessage;

        // Track context from assistant messages (correct source)
        if (this.orchestratorContextTracker) {
          this.updateContextFromAssistant(
            assistantMessage,
            this.orchestratorContextTracker,
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
   * THE FORMULA: baseline + (max(cache_read) - first(cache_read)) + last(cache_create)
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

    // Capture first cache_read as reference point
    if (tracker.firstCacheRead === 0) {
      tracker.firstCacheRead = cacheRead;
    }

    // Update tracking
    tracker.maxCacheRead = Math.max(tracker.maxCacheRead, cacheRead);
    tracker.lastCacheCreate = cacheCreate;  // Always overwrite with latest

    // Calculate context using THE FORMULA
    const tokens = getContextTokens(tracker);
    const pct = getContextPercent(tracker);
    const cacheGrowth = tracker.maxCacheRead - tracker.firstCacheRead;

    // Log for debugging
    this.callbacks.onDebugLog?.({
      type: 'system',
      agent,
      text: `Context: ${pct.toFixed(1)}% (${tokens.toLocaleString()} tokens)`,
      details: {
        messageId: msgId,
        uniqueApiCalls: tracker.seenMsgIds.size,
        formula: 'baseline + cache_growth + last_cache_create',
        baseline: tracker.baseline,
        first_cache_read: tracker.firstCacheRead,
        max_cache_read: tracker.maxCacheRead,
        cache_growth: cacheGrowth,
        last_cache_create: tracker.lastCacheCreate,
        this_message: { cache_read: cacheRead, cache_create: cacheCreate },
        total_tokens: tokens,
        percent: pct,
      },
    });

    // Update state and notify callback
    if (agent === 'arbiter') {
      updateArbiterContext(this.state, pct);
      const orchPct = this.state.currentOrchestrator
        ? getContextPercent(this.orchestratorContextTracker!)
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
