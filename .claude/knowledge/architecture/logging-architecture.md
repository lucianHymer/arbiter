# Arbiter Logging Architecture

Comprehensive logging infrastructure for the Arbiter system, including message flow, debug logging, and context tracking.

## Message Flow Architecture

Three-layer routing system:

### 1. Router.ts (Core Dispatcher)

- `handleArbiterMessage()` → processes SDK messages from Arbiter
- `handleArbiterOutput()` → adds to state conversationLog, calls onArbiterMessage callback, calls onDebugLog callback
- `handleOrchestratorMessage()` → processes orchestrator SDK messages
- `handleOrchestratorOutput()` → adds to state conversationLog, calls onOrchestratorMessage callback, calls onDebugLog callback

### 2. State.ts (Conversation History)

- `AppState.conversationLog`: Message[] array with speaker, text, timestamp
- `addMessage()` helper mutates state directly

### 3. TUI Callbacks (via React hooks)

- `onHumanMessage`: adds to React state, displays in ChatLog
- `onArbiterMessage`: adds to React state, displays in ChatLog (yellow)
- `onOrchestratorMessage`: adds to React state, displays in ChatLog (cyan)
- `onDebugLog`: routes DebugLogEntry to LogbookOverlay component

## Debug Log Entry Type

```typescript
type DebugLogEntry = {
  type: 'message' | 'tool' | 'system';
  speaker?: string;  // 'arbiter', 'human', 'Conjuring I', etc.
  text: string;
  filtered?: boolean;  // For echo filtering
  details?: any;  // Extra data like {tool, count}
}
```

## TUI Logbook Overlay

- **Access**: Ctrl+O toggles LogbookOverlay component
- **Views**: Two modes toggled with 'D' key
  - Summary mode: Shows only messages with timestamps
  - Debug mode: Shows all entries including tools, context, mode changes, system events
- **Display**: Full-screen React component with border styling

## Context Tracking

Context percentage calculation in router.ts:

- `MAX_CONTEXT_TOKENS = 200,000`
- Calculated from SDK result messages: `(input_tokens + cache_read_input_tokens + cache_creation_input_tokens) / 200000 * 100`
- Never decreases: `Math.max(newPercent, currentPercent)` prevents backsliding
- Tracked separately: `arbiterContextPercent`, `orchestratorContextPercent`
- Updated via `onContextUpdate` callback

## Tool Use Events

PostToolUse Hook in orchestrator.ts:

- Triggered after tool execution on Orchestrator
- Increments tool call count in `toolCallCounts` Map
- Updates state via `updateOrchestratorTool()`
- Calls `onToolUse` callback with tool name and count
- Calls `onDebugLog` with type:'tool', speaker:'Conjuring I', details {tool, count}
- Returns context warnings at 70% and 85% thresholds

## Mode Changes

- Logged to `state.mode`: 'human_to_arbiter' | 'arbiter_to_orchestrator'
- `onModeChange` callback triggered
- Used for scene positioning (Arbiter moves between positions based on mode)

## Integration Points

1. Router spawns all logged events via callbacks
2. `TUI.getRouterCallbacks()` creates callback object with onDebugLog handler
3. ChatLog component displays messages with color-coded speakers
4. LogbookOverlay component displays debug entries (Ctrl+O to toggle)

## Related Files

- src/router.ts
- src/tui/index.tsx
- src/tui/components/ChatLog.tsx
- src/tui/components/LogbookOverlay.tsx
- src/state.ts
- src/orchestrator.ts
