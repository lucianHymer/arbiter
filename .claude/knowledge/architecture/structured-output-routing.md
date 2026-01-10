# Orchestrator Structured Output Routing

Replaced fragile @ARBITER: text tag system with SDK structured outputs for deterministic message routing.

## The Problem

The original design used text tags like `@ARBITER: ...` in orchestrator messages to signal which messages should be forwarded to the Arbiter. This required parsing text, was fragile, and Claude didn't always follow the convention consistently.

## The Solution: Structured Outputs

Use the Claude SDK's `outputFormat` option with a Zod schema to enforce structured routing decisions.

### Schema Definition

```typescript
const OrchestratorOutputSchema = z.object({
  expects_response: z.boolean(),
  message: z.string(),
});

type OrchestratorOutput = z.infer<typeof OrchestratorOutputSchema>;
```

### Routing Logic

- `expects_response: true` → Forward message to Arbiter immediately (introductions, questions, handoffs, completion reports)
- `expects_response: false` → Queue message for later display (status updates during heads-down work)

## Implementation Details

1. **Schema definition** in router.ts using Zod
2. **outputFormat option** added to orchestrator `query()` calls
3. **Extract structured_output** from result messages (not assistant messages)
4. **handleOrchestratorOutput** takes `OrchestratorOutput` type instead of raw string

## Why This Works

- **Deterministic** - No text parsing or pattern matching
- **Type-safe** - Schema enforces the routing decision at compile time
- **Reliable** - Claude's structured output mode guarantees valid JSON

## Message Types

### Expects Response (forward to Arbiter)
- Orchestrator introductions ("Hello, I'm Conjuring I...")
- Questions requiring Arbiter input
- Task completion reports
- Handoffs back to Arbiter

### Does Not Expect Response (queue for later)
- Status updates while working
- Progress indicators
- Internal work narration

## Related Files

- src/router.ts: `OrchestratorOutputSchema`, `handleOrchestratorOutput()`
- src/orchestrator.ts: `outputFormat` configuration in query options
