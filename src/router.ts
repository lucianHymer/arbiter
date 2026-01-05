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
};

// Maximum context window size (200K tokens)
const MAX_CONTEXT_TOKENS = 200000;

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

  // Pending message to send to orchestrator after spawn
  private pendingOrchestratorPrompt: string | null = null;
  private pendingOrchestratorNumber: number = 0;

  // Track if we're currently processing messages
  private isProcessing = false;

  // Abort controllers for graceful shutdown
  private arbiterAbortController: AbortController | null = null;
  private orchestratorAbortController: AbortController | null = null;

  // Store MCP server for Arbiter session resumption
  private arbiterMcpServer: any = null;

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
      // Inject to Arbiter with Human tag
      await this.sendToArbiter(`Human: ${text}`);
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
      onSpawnOrchestrator: (prompt: string, orchestratorNumber: number) => {
        // Store the prompt and number to spawn after current processing
        this.pendingOrchestratorPrompt = prompt;
        this.pendingOrchestratorNumber = orchestratorNumber;
      },
      onDisconnectOrchestrators: () => {
        // Clean up current orchestrator
        if (this.orchestratorAbortController) {
          this.orchestratorAbortController.abort();
          this.orchestratorAbortController = null;
        }
        this.orchestratorQuery = null;
        clearCurrentOrchestrator(this.state);

        // Switch mode
        setMode(this.state, "human_to_arbiter");
        this.callbacks.onModeChange("human_to_arbiter");

        // Update context display (no orchestrator)
        this.callbacks.onContextUpdate(this.state.arbiterContextPercent, null);
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
  private async startOrchestratorSession(
    prompt: string,
    number: number
  ): Promise<void> {
    // Notify that we're waiting for Orchestrator
    this.callbacks.onWaitingStart?.('orchestrator');

    // Increment orchestrator count
    this.orchestratorCount = number;

    // Create abort controller for this session
    this.orchestratorAbortController = new AbortController();

    // Generate unique ID for this orchestrator
    const orchId = `orch-${Date.now()}`;

    // Track context percent for this session
    let currentContextPercent = 0;

    // Create callbacks for hooks
    const orchestratorCallbacks: OrchestratorCallbacks = {
      onContextUpdate: (_sessionId: string, percent: number) => {
        // Context should never decrease - use the maximum
        currentContextPercent = Math.max(percent, currentContextPercent);
        updateOrchestratorContext(this.state, currentContextPercent);
        this.callbacks.onContextUpdate(
          this.state.arbiterContextPercent,
          currentContextPercent
        );
      },
      onToolUse: (tool: string) => {
        // Increment tool count
        const currentCount = this.toolCallCounts.get(orchId) || 0;
        const newCount = currentCount + 1;
        this.toolCallCounts.set(orchId, newCount);

        // Update state and notify callback
        updateOrchestratorTool(this.state, tool, newCount);
        this.callbacks.onToolUse(tool, newCount);
      },
    };

    // Create hooks for context management
    const hooks = createOrchestratorHooks(
      orchestratorCallbacks,
      (_sessionId: string) => currentContextPercent
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

    // Create the orchestrator session with the initial prompt from Arbiter
    this.orchestratorQuery = query({
      prompt,
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
    // Log the message
    addMessage(this.state, "arbiter", text);

    // Notify callback
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

    // Log the message
    addMessage(this.state, orchLabel, text);

    // Notify callback
    this.callbacks.onOrchestratorMessage(orchNumber, text);

    // Route to Arbiter with tag
    await this.sendToArbiter(`${orchLabel}: ${text}`);
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
      if (this.pendingOrchestratorPrompt) {
        const prompt = this.pendingOrchestratorPrompt;
        const number = this.pendingOrchestratorNumber;
        this.pendingOrchestratorPrompt = null;
        this.pendingOrchestratorNumber = 0;

        await this.startOrchestratorSession(prompt, number);
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
        const textContent = this.extractTextFromAssistantMessage(
          assistantMessage
        );
        if (textContent) {
          await this.handleArbiterOutput(textContent);
        }
        break;

      case "result":
        // Update context percentage from usage data
        const resultMessage = message as SDKResultMessage;
        if (resultMessage.subtype === "success") {
          const usage = resultMessage.usage;
          const total =
            (usage.input_tokens || 0) +
            (usage.cache_read_input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0);
          const pct = (total / MAX_CONTEXT_TOKENS) * 100;

          console.log('[Context Debug] Arbiter:', {
            input: usage.input_tokens,
            cache_read: usage.cache_read_input_tokens,
            cache_creation: usage.cache_creation_input_tokens,
            total,
            pct,
            previous: this.state.arbiterContextPercent
          });

          // Context should never decrease - use the maximum of current and new
          const finalPct = Math.max(pct, this.state.arbiterContextPercent);
          updateArbiterContext(this.state, finalPct);

          // Notify callback
          const orchPct = this.state.currentOrchestrator?.contextPercent ?? null;
          this.callbacks.onContextUpdate(finalPct, orchPct);
        }
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
        const textContent = this.extractTextFromAssistantMessage(
          assistantMessage
        );
        if (textContent) {
          await this.handleOrchestratorOutput(textContent);
        }
        break;

      case "result":
        // Update context percentage from usage data
        const resultMessage = message as SDKResultMessage;
        if (resultMessage.subtype === "success") {
          const usage = resultMessage.usage;
          const total =
            (usage.input_tokens || 0) +
            (usage.cache_read_input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0);
          const pct = (total / MAX_CONTEXT_TOKENS) * 100;

          console.log('[Context Debug] Orchestrator:', {
            input: usage.input_tokens,
            cache_read: usage.cache_read_input_tokens,
            cache_creation: usage.cache_creation_input_tokens,
            total,
            pct,
            previous: this.state.currentOrchestrator?.contextPercent ?? 0
          });

          if (this.state.currentOrchestrator) {
            // Context should never decrease - use the maximum
            const previousPct = this.state.currentOrchestrator.contextPercent;
            const finalPct = Math.max(pct, previousPct);
            updateOrchestratorContext(this.state, finalPct);
            this.callbacks.onContextUpdate(
              this.state.arbiterContextPercent,
              finalPct
            );
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
}
