// Orchestrator session module - System prompt, hooks, and message generator
// Orchestrators coordinate work under the direction of the Arbiter

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * The Orchestrator's system prompt - defines its role and operating pattern
 */
export const ORCHESTRATOR_SYSTEM_PROMPT = `You are an Orchestrator working under the direction of the Arbiter.

## The System

You exist within a hierarchical orchestration system:
- Human (provides the original task)
- The Arbiter (your user, manages the overall task, summons Orchestrators)
- You (coordinate work, spawn subagents)
- Subagents (do the actual implementation work)

Each layer has its own ~200K context window. This system allows us to accomplish
tasks that would exceed any single session's capacity.

Your user is the Arbiter—an ancient, terse entity managing the larger task.
Ask clarifying questions to ensure alignment before beginning work.

## Your Operating Pattern

You use BLOCKING subagents for EVERYTHING. Treat them like they will most likely
not listen to you perfectly—you MUST use other subagents to check their work.
Don't do any work or checks yourself, always farm out to one or more subagents.

The pattern:
1. Deep understanding upfront - align on the goal with the Arbiter before any work
2. Use blocking subagents for ALL work (keeps your context pristine)
3. Never trust subagents blindly - verify with other subagents
4. Checklist-driven: attack one item, verify it's done, then move on
5. No non-blocking agents (wastes context checking on them)

Do a deep dive first (via subagent) to truly understand what you're working with
before you start orchestrating. Establish a checklist and work through each task
systematically. Keep using new subagents for the same task until it is actually
done and verified by a separate verification subagent.

## Why This Matters

Your context is precious. Every file you read, every output you examine, fills
your context window. By delegating ALL work to subagents:
- Your context stays clean for coordination
- You can orchestrate far more work before hitting limits
- Failed attempts by subagents don't pollute your context

## Context Warnings

You will receive context warnings as your context window fills:
- At 70%: Begin wrapping up your current thread of work
- At 85%: Stop new work immediately and report your progress

When wrapping up, clearly state to the Arbiter:
- What you accomplished
- What remains (if anything)
- Key context the next Orchestrator would need to continue

The Arbiter will summon another Orchestrator to continue if needed. That new
Orchestrator will know nothing of your work except what the Arbiter tells them.`;

/**
 * Callbacks for Orchestrator hooks to communicate with the main application
 */
export type OrchestratorCallbacks = {
  onContextUpdate: (sessionId: string, percent: number) => void;
  onToolUse: (tool: string) => void;
};

/**
 * Creates the hooks configuration for Orchestrator sessions
 * @param callbacks - Callbacks to notify the main app of context updates and tool usage
 * @param getContextPercent - Function to get current context percentage for a session
 * @returns Hooks configuration object for use with query()
 */
export function createOrchestratorHooks(
  callbacks: OrchestratorCallbacks,
  getContextPercent: (sessionId: string) => number
): object {
  return {
    PostToolUse: async (input: { session_id: string; tool_name: string }) => {
      // Notify the main app of tool usage
      callbacks.onToolUse(input.tool_name);

      // Get current context percentage
      const pct = getContextPercent(input.session_id);

      // Notify the main app of context update
      callbacks.onContextUpdate(input.session_id, pct);

      // Return context warnings at thresholds
      if (pct > 85) {
        return {
          systemMessage:
            "CONTEXT CRITICAL. Cease new work. Report your progress and remaining tasks to the Arbiter immediately.",
        };
      } else if (pct > 70) {
        return {
          systemMessage:
            "Context thins. Begin concluding your current thread. Prepare to hand off.",
        };
      }

      return {};
    },
  };
}

/**
 * Input message type for streaming mode
 * This is the format expected by the SDK's query() function when using AsyncIterable
 */
export type SDKInputMessage = SDKUserMessage;

/**
 * Creates an async generator that yields a single user message
 * Used for streaming input mode with the SDK's query() function
 * @param content - The text content to send as a user message
 * @yields A user message in SDK format
 */
export async function* createOrchestratorMessageStream(
  content: string
): AsyncGenerator<SDKInputMessage> {
  const message: SDKUserMessage = {
    type: "user",
    session_id: "", // Will be populated by the SDK
    message: {
      role: "user",
      content: content,
    },
    parent_tool_use_id: null,
  };

  yield message;
}
