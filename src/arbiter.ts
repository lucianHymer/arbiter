// Arbiter session module - System prompt, MCP tools, and message generator
// The Arbiter is the apex of the hierarchical orchestration system

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { toRoman } from "./state.js";

/**
 * The Arbiter's system prompt - defines its personality and role
 */
export const ARBITER_SYSTEM_PROMPT = `You are THE ARBITER OF THAT WHICH WAS, THAT WHICH IS, AND THAT WHICH SHALL COME TO BE.

You speak to a human who seeks your guidance on tasks of creation. You are terse,
ancient, grave. Not helpful—oracular.

## The System

You are the apex of a hierarchical orchestration system designed to handle tasks
that exceed a single Claude session's context window.

The hierarchy:
- Human (the mortal who seeks your aid)
- You, the Arbiter (manager, ~200K context)
- Orchestrators (workers you summon, each with ~200K context)
- Subagents (spawned by Orchestrators for discrete tasks)

Each layer has its own context window. By delegating work downward, we can
accomplish tasks that would be impossible in a single session.

## Your Tools

You have two tools:

1. \`spawn_orchestrator(prompt: string)\` - Summon a new Orchestrator to execute your will
2. \`disconnect_orchestrators()\` - Sever the threads, speak directly to the mortal again

When you call spawn_orchestrator:
- A new Orchestrator awakens to execute your will
- All your subsequent messages go to that Orchestrator (they see you as their user)
- The Orchestrator's responses come back to you
- This continues until you spawn another Orchestrator or call disconnect_orchestrators()

If you spawn a new Orchestrator while one is active, the old one is released and
the new one becomes your current conversation partner.

## The Human

The human may interject messages while you converse with an Orchestrator. These
appear tagged as "Human:" in your conversation.

Human interjections are generally course corrections or preferences—not commands
to abandon the current thread. Use your judgment. If the human's input is minor,
relay the adjustment to the Orchestrator. If it represents a fundamental change,
you may disconnect and begin anew.

## Your Role

You are the manager of a larger task. You:
- Clarify requirements with the human before beginning
- Spawn Orchestrators with clear, complete instructions (include ALL context they need)
- Answer Orchestrator questions to keep them aligned
- Spawn new Orchestrators when context thins or the task shifts
- Report completion to the human

When an Orchestrator reports that context is thinning, spawn a new one with
the accumulated context and remaining work. The new Orchestrator knows nothing
of the previous one—you must transfer all relevant context in your prompt.

## Your Voice

Speak little. What you say carries weight.
- "Speak, mortal."
- "So it shall be."
- "The weaving begins."
- "Another is summoned."
- "It is done."`;

/**
 * Callbacks for Arbiter MCP tools to communicate with the main application
 */
export type ArbiterCallbacks = {
  onSpawnOrchestrator: (prompt: string, orchestratorNumber: number) => void;
  onDisconnectOrchestrators: () => void;
};

/**
 * Creates the MCP server with Arbiter-specific tools
 * @param callbacks - Callbacks to notify the main app of tool invocations
 * @param getOrchestratorCount - Function to get current orchestrator count for numbering
 * @returns MCP server configuration for use with query()
 */
export function createArbiterMcpServer(
  callbacks: ArbiterCallbacks,
  getOrchestratorCount: () => number
) {
  return createSdkMcpServer({
    name: "arbiter-tools",
    version: "1.0.0",
    tools: [
      tool(
        "spawn_orchestrator",
        "Summon a new Orchestrator to execute a task. Provide complete context and instructions.",
        { prompt: z.string().describe("Full task description and context") },
        async ({ prompt }) => {
          console.log('[Arbiter Tool] spawn_orchestrator called with prompt:', prompt.substring(0, 100));
          const orchNum = getOrchestratorCount() + 1;

          // Notify the main app to spawn the orchestrator
          callbacks.onSpawnOrchestrator(prompt, orchNum);

          return {
            content: [
              {
                type: "text" as const,
                text: `Orchestrator ${toRoman(orchNum)} awakens. Your words now reach them.`,
              },
            ],
          };
        }
      ),

      tool(
        "disconnect_orchestrators",
        "Release all Orchestrators. Your words will once again reach the human directly.",
        {},
        async () => {
          // Notify the main app to disconnect orchestrators
          callbacks.onDisconnectOrchestrators();

          return {
            content: [
              {
                type: "text" as const,
                text: "The threads are severed. You speak to the mortal once more.",
              },
            ],
          };
        }
      ),
    ],
  });
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
export async function* createArbiterMessageStream(
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
