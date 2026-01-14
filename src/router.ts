// Message Router - Core component managing sessions and routing messages
// Handles Arbiter and Orchestrator session lifecycle and message routing

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { type PersistedSession, saveSession } from './session-persistence.js';

// Helper for async delays
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Log file paths (gitignore handled by GitignoreCheck screen on startup)
const CRASH_LOG_PATH = join(process.cwd(), '.claude', 'arbiter-crash-report.log');
const CHAT_LOG_PATH = join(process.cwd(), '.claude', 'arbiter-chat-history.log');

/**
 * Append error details to crash log file.
 * No filtering - logs everything for debugging.
 */
function logCrashToFile(
  source: 'arbiter' | 'orchestrator',
  error: unknown,
  context?: object,
): void {
  const timestamp = new Date().toISOString();
  const errorObj = error as Record<string, unknown>;

  const entry = {
    timestamp,
    source,
    error: {
      message: errorObj?.message ?? String(error),
      name: errorObj?.name,
      code: errorObj?.code,
      stack: errorObj?.stack,
      cause: errorObj?.cause,
    },
    context,
    raw: String(error),
  };

  try {
    appendFileSync(CRASH_LOG_PATH, `${JSON.stringify(entry, null, 2)}\n---\n`, 'utf8');
  } catch {
    // If we can't write, just continue - don't crash over crash logging
  }
}

/**
 * Append chat message to history log file.
 */
function logChatToFile(speaker: string, message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${speaker}: ${message}\n`;

  try {
    appendFileSync(CHAT_LOG_PATH, line, 'utf8');
  } catch {
    // If we can't write, just continue
  }
}

/**
 * Log session start marker to chat history.
 * Format allows reading file backwards to find session start.
 */
function logSessionStart(sessionId: string, isResume: boolean): void {
  const timestamp = new Date().toISOString();
  const marker = isResume ? 'SESSION_RESUME' : 'SESSION_START';
  const line = `\n=== ${marker} [${timestamp}] session:${sessionId} ===\n\n`;

  try {
    appendFileSync(CHAT_LOG_PATH, line, 'utf8');
  } catch {
    // If we can't write, just continue
  }
}

// Retry constants for crash recovery
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // 1s, 2s, 4s exponential backoff

// Type for context polling function - bound to specific session options
type ContextPoller = (sessionId: string) => Promise<number | null>;

/**
 * Creates a query and a paired context poller that uses the same options.
 * This ensures context polling always matches the session's actual configuration.
 *
 * @param prompt - Initial prompt for the session
 * @param options - Options used to create the session (will also be used for polling)
 * @returns Tuple of [query generator, context polling function]
 */
function createQueryWithPoller(
  prompt: string,
  options: Options,
): [ReturnType<typeof query>, ContextPoller] {
  const q = query({ prompt, options });

  const pollContext: ContextPoller = async (sessionId: string) => {
    try {
      const pollQuery = query({
        prompt: '/context',
        options: {
          ...options,
          resume: sessionId,
          forkSession: true, // Fork to avoid polluting main session
        },
      });

      let percent: number | null = null;

      for await (const msg of pollQuery) {
        // /context output comes through as user message with the token info
        if (msg.type === 'user') {
          const content = (msg as { message?: { content?: string } }).message?.content;
          if (typeof content === 'string') {
            // Match: **Tokens:** 18.4k / 200.0k (9%)
            const match = content.match(
              /\*\*Tokens:\*\*\s*([0-9.]+)k\s*\/\s*200\.?0?k\s*\((\d+)%\)/i,
            );
            if (match) {
              percent = parseInt(match[2], 10);
            }
          }
        }
      }

      return percent;
    } catch (_error) {
      // Silently fail - context polling is best-effort
      return null;
    }
  };

  return [q, pollContext];
}

// canUseTool for Arbiter - read-only manager, guides toward spawning orchestrators
const arbiterCanUseTool: CanUseTool = async (toolName, input) => {
  // Write operations should be delegated to orchestrators
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    return {
      behavior: 'deny',
      message:
        'You cannot write files directly. Use mcp__arbiter-tools__spawn_orchestrator to delegate implementation work to an Orchestrator.',
    };
  }

  // No AskUserQuestion tool - just ask in your message text instead
  if (toolName === 'AskUserQuestion') {
    return {
      behavior: 'deny',
      message:
        'This tool is not available. If you need to ask the user something, just ask in your message.',
    };
  }

  // No plan mode
  if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') {
    return { behavior: 'deny', message: 'Plan mode is not available.' };
  }

  return { behavior: 'allow', updatedInput: input };
};

// canUseTool for Orchestrator - full access except user interaction
const orchestratorCanUseTool: CanUseTool = async (toolName, input) => {
  // No AskUserQuestion tool - just ask in your message text instead
  if (toolName === 'AskUserQuestion') {
    return {
      behavior: 'deny',
      message:
        'This tool is not available. If you need to ask something, just ask in your message.',
    };
  }

  // No plan mode
  if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') {
    return { behavior: 'deny', message: 'Plan mode is not available.' };
  }

  return { behavior: 'allow', updatedInput: input };
};

import type { AppState, ArbiterIntent } from './state.js';
import {
  addMessage,
  clearCurrentOrchestrator,
  setCurrentOrchestrator,
  toRoman,
  updateArbiterContext,
  updateOrchestratorContext,
  updateOrchestratorTool,
} from './state.js';

/**
 * Schema for Orchestrator structured output
 * Simple routing decision: does this message expect a response?
 */
const OrchestratorOutputSchema = z.object({
  expects_response: z
    .boolean()
    .describe(
      'True if you need input from the Arbiter (questions, introductions, handoffs). False for status updates during heads-down work.',
    ),
  message: z.string().describe('The message content'),
});

type OrchestratorOutput = z.infer<typeof OrchestratorOutputSchema>;

// Convert to JSON Schema for SDK
const orchestratorOutputJsonSchema = zodToJsonSchema(OrchestratorOutputSchema, {
  $refStrategy: 'none',
});

/**
 * Schema for Arbiter structured output
 * Controls message routing and orchestrator lifecycle
 */
const ArbiterOutputSchema = z.object({
  intent: z
    .enum([
      'address_human',
      'address_orchestrator',
      'summon_orchestrator',
      'release_orchestrators',
      'musings',
    ])
    .describe(
      `What happens with this message and the conversation:
- address_human: Message to the human, awaiting their response.
- address_orchestrator: Message to the active orchestrator, awaiting their response.
- summon_orchestrator: This message is shown to the human. After this, a new Orchestrator awakens and introduces themselves. If an Orchestrator is already active, they are released and replaced.
- release_orchestrators: Sever all orchestrator connections. This message (and all future messages) go to the human.
- musings: Thinking aloud. Displayed for context but no response expected.`,
    ),
  message: z.string().describe('Your message content'),
});

type ArbiterOutput = z.infer<typeof ArbiterOutputSchema>;

// Convert to JSON Schema for SDK
const arbiterOutputJsonSchema = zodToJsonSchema(ArbiterOutputSchema, {
  $refStrategy: 'none',
});

import {
  ARBITER_SYSTEM_PROMPT,
  type ArbiterHooksCallbacks,
  createArbiterHooks,
} from './arbiter.js';

import {
  createOrchestratorHooks,
  ORCHESTRATOR_SYSTEM_PROMPT,
  type OrchestratorCallbacks,
} from './orchestrator.js';

/**
 * Log entry types for debug logging
 */
export type DebugLogEntry = {
  type: 'message' | 'tool' | 'system' | 'sdk';
  speaker?: string; // For messages: 'human', 'arbiter', 'Orchestrator I', etc.
  text: string;
  filtered?: boolean; // True if this was filtered from main chat
  details?: any;
  agent?: 'arbiter' | 'orchestrator'; // For SDK messages
  sessionId?: string; // SDK session ID
  messageType?: string; // SDK message type (system, assistant, user, result)
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
  onContextUpdate: (arbiterPercent: number, orchestratorPercent: number | null) => void;
  /** Called when a tool is used by the Orchestrator */
  onToolUse: (tool: string, count: number) => void;
  /** Called when the Arbiter declares an intent (for visual feedback like walking) */
  onArbiterIntent?: (intent: ArbiterIntent) => void;
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

// Context polling interval (1 minute)
const CONTEXT_POLL_INTERVAL_MS = 60_000;

/**
 * Orchestrator session state - bundles all orchestrator-related data
 * This replaces the scattered properties that were previously on Router
 */
interface OrchestratorSession {
  id: string; // Unique ID (e.g., "orch-1234567890")
  number: number; // Roman numeral suffix (I, II, III...)
  sessionId: string; // SDK session ID for resuming
  query: ReturnType<typeof query> | null; // The active query generator
  abortController: AbortController; // For killing the session
  toolCallCount: number; // Total tool calls made (was in Map, now here)
  queue: string[]; // Queued messages awaiting flush to Arbiter
  lastActivityTime: number; // For watchdog timeout detection
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>; // SDK hooks for tool tracking
  pollContext: ContextPoller; // Paired context poller using same options as session
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
            const contentStr =
              typeof resultBlock.content === 'string'
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
        const total =
          (usage.input_tokens || 0) +
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
  return `${clean.substring(0, maxLength - 3)}...`;
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
  orchNumber: number,
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
function formatTimeoutForArbiter(queue: string[], orchNumber: number, idleMinutes: number): string {
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

  // Pending orchestrator spawn flag (set by structured output intent)
  private pendingOrchestratorSpawn: boolean = false;

  // Abort controllers for graceful shutdown
  private arbiterAbortController: AbortController | null = null;

  // Watchdog timer for orchestrator inactivity detection
  private watchdogInterval: NodeJS.Timeout | null = null;

  // Store Arbiter hooks for session resumption
  private arbiterHooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> | null = null;

  // Paired context poller for Arbiter (uses same options as session)
  private arbiterPollContext: ContextPoller | null = null;

  // Context polling timer - polls /context once per minute via session forking
  private contextPollInterval: NodeJS.Timeout | null = null;

  // Track if current session is a resume (for chat log markers)
  private isResumingSession: boolean = false;

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
   * Uses paired pollers that share the same options as the sessions
   */
  private async pollAllContexts(): Promise<void> {
    // Poll Arbiter context using paired poller
    if (this.state.arbiterSessionId && this.arbiterPollContext) {
      const arbiterPercent = await this.arbiterPollContext(this.state.arbiterSessionId);
      if (arbiterPercent !== null) {
        updateArbiterContext(this.state, arbiterPercent);
        this.callbacks.onDebugLog?.({
          type: 'system',
          text: `Context poll: Arbiter at ${arbiterPercent}%`,
          agent: 'arbiter',
        });
      }
    }

    // Poll Orchestrator context using paired poller
    let orchPercent: number | null = null;
    const orchSession = this.currentOrchestratorSession;
    if (orchSession?.sessionId && orchSession.pollContext) {
      orchPercent = await orchSession.pollContext(orchSession.sessionId);
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
      this.state.currentOrchestrator?.contextPercent ?? null,
    );
  }

  /**
   * Resume from a previously saved session
   */
  async resumeFromSavedSession(saved: PersistedSession): Promise<void> {
    // Start arbiter with resume session ID
    await this.startArbiterSession(saved.arbiterSessionId);

    // If there was an active orchestrator, resume it too
    if (saved.orchestratorSessionId && saved.orchestratorNumber) {
      await this.startOrchestratorSession(saved.orchestratorNumber, saved.orchestratorSessionId);
    }

    // Start context polling
    this.startContextPolling();
  }

  /**
   * Send a human message to the system
   * Routes based on whether an orchestrator is active:
   * - No orchestrator: Send directly to Arbiter
   * - Orchestrator active: Flush queue with human interjection framing
   */
  async sendHumanMessage(text: string): Promise<void> {
    // Log the human message and notify TUI immediately
    addMessage(this.state, 'human', text);
    logChatToFile('Human', text);
    this.callbacks.onHumanMessage(text);

    if (this.currentOrchestratorSession) {
      const session = this.currentOrchestratorSession;

      // Human interjection during orchestrator work - flush queue with context
      const formattedMessage = formatQueueForArbiter(session.queue, text, 'human', session.number);

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
      // Direct to Arbiter (no orchestrator active)
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

    // 3. Null out the session
    this.currentOrchestratorSession = null;

    // 4. Update shared state for TUI
    clearCurrentOrchestrator(this.state);

    // 5. Update context display (no orchestrator)
    this.callbacks.onContextUpdate(this.state.arbiterContextPercent, null);

    // 6. Notify TUI about orchestrator disconnect (for tile scene)
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
    const timeoutMessage = formatTimeoutForArbiter(session.queue, session.number, idleMinutes);

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
      hooks: this.arbiterHooks ?? undefined,
      abortController: this.arbiterAbortController ?? new AbortController(),
      settingSources: ['project'], // Load CLAUDE.md for project context
      canUseTool: arbiterCanUseTool,
      outputFormat: {
        type: 'json_schema',
        schema: arbiterOutputJsonSchema,
      },
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
    resumeSessionId?: string,
  ): Options {
    return {
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
      hooks,
      abortController,
      settingSources: ['project'], // Load CLAUDE.md for project context
      canUseTool: orchestratorCanUseTool,
      outputFormat: {
        type: 'json_schema',
        schema: orchestratorOutputJsonSchema,
      },
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    };
  }

  /**
   * Creates and starts the Arbiter session with structured output routing
   * @param resumeSessionId - Optional session ID for resuming an existing session
   */
  private async startArbiterSession(resumeSessionId?: string): Promise<void> {
    // Track if this is a resume for chat log markers
    this.isResumingSession = !!resumeSessionId;

    // Notify that we're waiting for Arbiter
    this.callbacks.onWaitingStart?.('arbiter');

    // Create abort controller for this session
    this.arbiterAbortController = new AbortController();

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

    // Create hooks for tool tracking
    const hooks = createArbiterHooks(arbiterHooksCallbacks);
    this.arbiterHooks = hooks;

    // Create options using helper
    const options = this.createArbiterOptions(resumeSessionId);

    // Choose prompt based on whether resuming or starting fresh
    const prompt = resumeSessionId
      ? '[System: Session resumed. Continue where you left off.]'
      : this.state.requirementsPath
        ? `@${this.state.requirementsPath}

A Scroll of Requirements has been presented.

Your task now is to achieve COMPLETE UNDERSTANDING before any work begins. This is the most critical phase. Follow your system prompt's Phase 1 protocol rigorously:

1. **STUDY THE SCROLL** - Read every word. Understand the intent, not just the surface requirements.

2. **INVESTIGATE THE CODEBASE** - Use your read tools extensively. Understand the current state, architecture, patterns, and constraints. See what exists. See what's missing.

3. **IDENTIFY GAPS AND AMBIGUITIES** - What's unclear? What assumptions are being made? What edge cases aren't addressed? What could go wrong?

4. **ASK CLARIFYING QUESTIONS** - Do not proceed with partial understanding. Ask everything you need to know. Resolve ALL ambiguity NOW, before any Orchestrator is summoned.

5. **STATE BACK YOUR FULL UNDERSTANDING** - Once you've investigated and asked your questions, articulate back to me: What exactly will be built? What approach will be taken? What are the success criteria? What are the risks?

Only when we have achieved 100% alignment on vision, scope, and approach - only when you could explain this task to an Orchestrator with complete confidence - only then do we proceed.

Take your time. This phase determines everything that follows.`
        : 'Speak, mortal.';

    const [arbiterQuery, pollContext] = createQueryWithPoller(prompt, options);
    this.arbiterQuery = arbiterQuery;
    this.arbiterPollContext = pollContext;

    // Store session ID if resuming (will be updated from init message if new)
    if (resumeSessionId) {
      this.state.arbiterSessionId = resumeSessionId;
    }

    // Process the initial response
    await this.processArbiterMessages(this.arbiterQuery);
  }

  /**
   * Creates and starts an Orchestrator session
   * @param number - The orchestrator number (I, II, III...)
   * @param resumeSessionId - Optional session ID for resuming an existing session
   */
  private async startOrchestratorSession(number: number, resumeSessionId?: string): Promise<void> {
    // Clean up any existing orchestrator before spawning/resuming
    this.cleanupOrchestrator();

    // Notify that we're waiting for Orchestrator
    this.callbacks.onWaitingStart?.('orchestrator');

    // Set orchestrator count
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
          const orchestratorLabel = `Orchestrator ${toRoman(number)}`;
          this.callbacks.onDebugLog?.({
            type: 'tool',
            speaker: orchestratorLabel,
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
      (_sessionId: string) => this.state.currentOrchestrator?.contextPercent || 0,
    );

    // Create options using helper
    const options = this.createOrchestratorOptions(hooks, abortController, resumeSessionId);

    // Choose prompt based on whether resuming or starting fresh
    const prompt = resumeSessionId
      ? '[System: Session resumed. Continue where you left off.]'
      : `You are Orchestrator ${toRoman(number)}. Introduce yourself and await instructions from the Arbiter.`;

    // Create the orchestrator query with paired context poller
    const [orchestratorQuery, pollContext] = createQueryWithPoller(prompt, options);

    // Create the full OrchestratorSession object
    this.currentOrchestratorSession = {
      id: orchId,
      number,
      sessionId: resumeSessionId ?? '', // Known if resuming, will be set from init message if new
      query: orchestratorQuery,
      abortController,
      toolCallCount: 0,
      queue: [],
      lastActivityTime: Date.now(),
      hooks,
      pollContext,
    };

    // Set up TUI-facing orchestrator state
    setCurrentOrchestrator(this.state, {
      id: orchId,
      sessionId: resumeSessionId ?? '',
      number,
    });

    // Notify about orchestrator spawn (for tile scene demon spawning)
    this.callbacks.onOrchestratorSpawn?.(number);

    // Update context display to show orchestrator (initially at 0%)
    this.callbacks.onContextUpdate(
      this.state.arbiterContextPercent,
      this.state.currentOrchestrator?.contextPercent ?? null,
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
      console.error('Arbiter session not started');
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
      console.error('No active orchestrator session');
      return;
    }

    // Notify that we're waiting for Orchestrator
    this.callbacks.onWaitingStart?.('orchestrator');

    // Create a new query to continue the conversation
    const options = this.createOrchestratorOptions(
      this.currentOrchestratorSession.hooks,
      this.currentOrchestratorSession.abortController,
      this.currentOrchestratorSession.sessionId,
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
   * Handle Arbiter structured output - route based on intent field
   * The intent determines where the message goes and what state changes occur
   */
  private async handleArbiterOutput(output: ArbiterOutput): Promise<void> {
    const { intent, message } = output;

    // Log the message (always, for history/debug)
    addMessage(this.state, 'arbiter', message);
    logChatToFile('Arbiter', message);

    // Log to debug (logbook)
    this.callbacks.onDebugLog?.({
      type: 'message',
      speaker: 'arbiter',
      text: message,
      details: { intent },
    });

    // Notify TUI for visual feedback (walking to position)
    this.callbacks.onArbiterIntent?.(intent);

    // Always display the message to the appropriate audience
    this.callbacks.onArbiterMessage(message);

    // Handle based on intent
    switch (intent) {
      case 'address_human':
        // Message already displayed, waiting for human response
        break;

      case 'address_orchestrator':
        // Forward to the active orchestrator
        if (this.currentOrchestratorSession) {
          await this.sendToOrchestrator(message);
        } else {
          // No orchestrator active - log warning
          this.callbacks.onDebugLog?.({
            type: 'system',
            text: 'Arbiter tried to address orchestrator but none is active',
          });
        }
        break;

      case 'summon_orchestrator':
        // Message shown to human, then orchestrator spawns after this turn
        this.pendingOrchestratorSpawn = true;
        break;

      case 'release_orchestrators':
        // Cleanup orchestrator, message goes to human
        this.cleanupOrchestrator();
        break;

      case 'musings':
        // Message displayed, no response expected - nothing more to do
        break;
    }
  }

  /**
   * Handle Orchestrator output - route based on expects_response field
   * expects_response: true → forward to Arbiter (questions, introductions, handoffs)
   * expects_response: false → queue for later (status updates during work)
   */
  private async handleOrchestratorOutput(output: OrchestratorOutput): Promise<void> {
    if (!this.currentOrchestratorSession) {
      console.error('No active orchestrator for output');
      return;
    }

    const session = this.currentOrchestratorSession;
    const orchNumber = session.number;
    const orchLabel = `Orchestrator ${toRoman(orchNumber)}`;
    const { expects_response, message } = output;

    // Log the message
    addMessage(this.state, orchLabel, message);
    logChatToFile(orchLabel, message);

    // Log to debug (logbook)
    this.callbacks.onDebugLog?.({
      type: 'message',
      speaker: orchLabel,
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
        orchNumber,
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
  private async processArbiterMessages(generator: ReturnType<typeof query>): Promise<void> {
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
        } catch (error: unknown) {
          // Log ALL errors to crash report file - no filtering
          logCrashToFile('arbiter', error, {
            retries,
            sessionId: this.state.arbiterSessionId,
          });

          // Also log to debug log
          const errorObj = error as Record<string, unknown>;
          this.callbacks.onDebugLog?.({
            type: 'system',
            text: `Arbiter error caught, retry ${retries + 1}/${MAX_RETRIES}`,
            details: {
              error: errorObj?.message || String(error),
              name: errorObj?.name,
              code: errorObj?.code,
            },
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
            prompt: '[System: Session resumed after error. Continue where you left off.]',
            options,
          });
          this.arbiterQuery = currentGenerator;
        }
      }

      // Stop waiting animation after Arbiter response is complete
      this.callbacks.onWaitingStop?.();

      // Check if we need to spawn an orchestrator (intent was summon_orchestrator)
      if (this.pendingOrchestratorSpawn) {
        this.pendingOrchestratorSpawn = false;
        // Increment count and spawn with the new number
        this.orchestratorCount++;
        await this.startOrchestratorSession(this.orchestratorCount);
      }
    } catch (error) {
      console.error('Error processing Arbiter messages:', error);
      throw error;
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
      case 'system':
        if ((message as SDKSystemMessage).subtype === 'init') {
          // Capture session ID
          this.state.arbiterSessionId = message.session_id;

          // Log session start marker to chat history
          logSessionStart(message.session_id, this.isResumingSession);

          // Save session for crash recovery
          saveSession(
            message.session_id,
            this.currentOrchestratorSession?.sessionId ?? null,
            this.currentOrchestratorSession?.number ?? null,
          );
        }
        break;

      case 'assistant': {
        // Track tool use from Arbiter (read-only tools)
        const assistantMessage = message as SDKAssistantMessage;
        this.trackToolUseFromAssistant(assistantMessage, 'arbiter');
        // Note: We don't extract text here anymore - output comes from structured_output
        break;
      }

      case 'result': {
        // Handle structured output from successful result messages
        const resultMessage = message as SDKResultMessage;
        if (resultMessage.subtype === 'success') {
          const structuredOutput = (resultMessage as any).structured_output;
          if (structuredOutput) {
            // Parse and validate the structured output
            const parsed = ArbiterOutputSchema.safeParse(structuredOutput);
            if (parsed.success) {
              await this.handleArbiterOutput(parsed.data);
            } else {
              // Log parsing error but don't crash
              this.callbacks.onDebugLog?.({
                type: 'system',
                text: `Failed to parse arbiter output: ${parsed.error.message}`,
                details: { structuredOutput, error: parsed.error },
              });
            }
          }
        }
        break;
      }
    }
  }

  /**
   * Process messages from an Orchestrator session with retry logic for crash recovery
   */
  private async processOrchestratorMessages(generator: ReturnType<typeof query>): Promise<void> {
    let retries = 0;
    let currentGenerator: ReturnType<typeof query> = generator;

    while (true) {
      try {
        for await (const message of currentGenerator) {
          // Reset retries on each successful message
          retries = 0;

          // Update activity time on ANY SDK message (including subagent results)
          // This prevents false timeouts when orchestrator delegates to Task subagents
          if (this.currentOrchestratorSession) {
            this.currentOrchestratorSession.lastActivityTime = Date.now();
          }

          await this.handleOrchestratorMessage(message);
        }
        // Successfully finished processing
        break;
      } catch (error: unknown) {
        // Log ALL errors to crash report file - no filtering
        logCrashToFile('orchestrator', error, {
          retries,
          sessionId: this.currentOrchestratorSession?.sessionId,
          orchestratorNumber: this.currentOrchestratorSession?.number,
        });

        // Also log to debug log
        const errorObj = error as Record<string, unknown>;
        this.callbacks.onDebugLog?.({
          type: 'system',
          text: `Orchestrator error caught, retry ${retries + 1}/${MAX_RETRIES}`,
          details: {
            error: errorObj?.message || String(error),
            name: errorObj?.name,
            code: errorObj?.code,
          },
        });

        // Check if we've exceeded max retries
        if (retries >= MAX_RETRIES) {
          // Orchestrator can't be resumed - cleanup and return (don't crash the whole app)
          console.error('Orchestrator exceeded max retries, cleaning up:', error);
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
          this.currentOrchestratorSession.sessionId,
        );

        currentGenerator = query({
          prompt: '[System: Session resumed after error. Continue where you left off.]',
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
      case 'system':
        if ((message as SDKSystemMessage).subtype === 'init') {
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
            this.currentOrchestratorSession?.number ?? null,
          );
        }
        break;

      case 'assistant':
        // Note: Context is tracked via periodic polling, not per-message
        // We don't extract text from assistant messages - output comes from structured_output
        break;

      case 'result': {
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
  }

  /**
   * Track tool_use blocks from an assistant message
   * Used for both Arbiter and Orchestrator tool tracking
   */
  private trackToolUseFromAssistant(
    message: SDKAssistantMessage,
    agent: 'arbiter' | 'orchestrator',
  ): void {
    const content = message.message.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === 'tool_use') {
        const toolBlock = block as { type: 'tool_use'; id: string; name: string; input: any };
        const toolName = toolBlock.name;

        // Log tool use for this agent
        const speaker =
          agent === 'arbiter'
            ? 'Arbiter'
            : `Orchestrator ${toRoman(this.state.currentOrchestrator?.number ?? 1)}`;
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
