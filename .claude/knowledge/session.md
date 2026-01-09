### [18:57] [architecture] Orchestrator structured output routing
**Details**: Replaced fragile @ARBITER: text tag system with SDK structured outputs for routing orchestrator messages.

Schema: { expects_response: boolean, message: string }

- expects_response: true → forward to Arbiter (introductions, questions, handoffs)
- expects_response: false → queue for later (status updates during heads-down work)

Implementation:
- Zod schema OrchestratorOutputSchema in router.ts
- outputFormat option added to orchestrator query() calls
- structured_output extracted from result messages (not assistant messages)
- handleOrchestratorOutput now takes OrchestratorOutput type instead of string

This is deterministic - no parsing text for tags, schema enforces the routing decision.
**Files**: src/router.ts, src/orchestrator.ts
---

### [22:30] [architecture] Context tracking via session fork polling
**Details**: Switched from calculation-based context tracking to polling-based approach. Instead of calculating context from SDK usage tokens (which was unreliable), we now fork sessions using `resume: sessionId` + `forkSession: true`, run `/context`, and parse the authoritative result. Polling happens once per minute for both Arbiter and Orchestrator sessions. This is 100% accurate vs the previous ~0.3% error rate that degraded under heavy tool use.
**Files**: src/router.ts
---

