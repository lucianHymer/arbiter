# Intent-Based Routing Architecture

Major architectural change replacing mode-based routing with intent-based structured outputs from the Arbiter.

## The Change

### Before (Mode-Based)

- `AppState.mode`: 'human_to_arbiter' | 'arbiter_to_orchestrator'
- MCP tools: `spawn_orchestrator()`, `disconnect_orchestrators()`
- Router checked mode to decide where to route messages
- Arbiter had to "remember" to call tools
- Risk of forgetting to call tools or inconsistent routing

### After (Intent-Based)

- No mode field in AppState
- `ArbiterOutputSchema` with explicit intent field
- Each Arbiter turn explicitly declares intent via structured output
- Router switches on intent to determine routing

## ArbiterIntent Type

```typescript
type ArbiterIntent =
  | 'address_human'        // Speaking to the human user
  | 'address_orchestrator' // Speaking to active orchestrator
  | 'summon_orchestrator'  // Spawn a new orchestrator
  | 'release_orchestrators'// Disconnect all orchestrators
  | 'musings';            // Internal thoughts (not routed)
```

## How It Works

1. Arbiter's query uses `outputFormat` with Zod schema
2. Schema requires `intent` field plus `message` string
3. After each Arbiter turn, extract `structured_output` from result
4. Router's `handleArbiterOutput` switches on intent:
   - `address_human` → Display to user
   - `address_orchestrator` → Forward to orchestrator
   - `summon_orchestrator` → Spawn new orchestrator session
   - `release_orchestrators` → Disconnect active orchestrators
   - `musings` → Log only, not displayed

## Benefits

- **Deterministic**: No "forgetting" to call tools
- **Single source of truth**: Intent field IS the routing decision
- **Easier to reason about**: Each turn is self-describing
- **Type-safe**: Schema enforced via Zod + zodToJsonSchema
- **No MCP overhead**: Direct structured output, no tool call latency

## Key Changes from MCP Tools

| Before | After |
|--------|-------|
| `spawn_orchestrator()` MCP tool | `summon_orchestrator` intent |
| `disconnect_orchestrators()` MCP tool | `release_orchestrators` intent |
| Mode field tracking state | Intent field per-turn |
| Router checked mode | Router switches on intent |
| Callback: `onModeChange` | Callback: `onArbiterIntent` |

## Related Files

- src/state.ts: `ArbiterIntent` type (mode removed)
- src/arbiter.ts: `ArbiterOutputSchema`, updated system prompt
- src/router.ts: Intent-based switch in `handleArbiterOutput()`
- src/tui/callbacks.ts: `onArbiterIntent` callback
