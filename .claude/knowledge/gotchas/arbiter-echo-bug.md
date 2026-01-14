# Message Routing Bug - Arbiter Echo Problem

**Date discovered:** 2026-01-05

## The Bug

Arbiter echoing orchestrator messages with "Human: Orchestrator I: ..." prefixes.

## Root Cause in router.ts

1. `handleOrchestratorOutput()` (lines 437-453):
   - Correctly calls `onOrchestratorMessage(orchNumber, text)` → TUI shows "Orchestrator I: text"
   - BUT ALSO calls `await this.sendToArbiter(\`${orchLabel}: ${text}\`)` which sends to Arbiter

2. `sendToArbiter()` creates a new SDK query with the orchestrator's message as input

3. Arbiter receives "Orchestrator I: text" and processes it as a user message, then responds

4. `handleArbiterOutput()` (lines 418-431):
   - Always calls `onArbiterMessage(text)` → TUI shows "Arbiter: text"
   - The Arbiter's response often echoes or acknowledges the orchestrator message

## Design Intention (from arbiter.ts system prompt lines 69-83)

- "Once you spawn an Orchestrator, become SILENT"
- "DO NOT: Add commentary or narration while the Orchestrator works"
- "Wait. Watch. The Orchestrator will report when their work is done."

**BUT:** The architecture forces Arbiter responses through onArbiterMessage callback regardless of mode.

## Potential Fixes

1. In `handleArbiterOutput()`, when mode is "arbiter_to_orchestrator", suppress the `onArbiterMessage` callback unless Arbiter is actually saying something meaningful (not just forwarding/echoing)
2. Check if Arbiter's text is just echoing/acknowledging orchestrator and skip the callback
3. Only call onArbiterMessage when mode is "human_to_arbiter"
4. Modify the design so Arbiter doesn't respond when receiving orchestrator messages (harder)

## Related Files

- src/router.ts
- src/arbiter.ts
- src/tui/index.ts
