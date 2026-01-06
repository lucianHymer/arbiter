### [00:18] [logging] Arbiter Logging Architecture (Updated for Ink)
**Details**: The Arbiter system has a comprehensive logging infrastructure:

## Message Flow Architecture
**Three-layer routing:**
1. **Router.ts (core dispatcher)**
   - handleArbiterMessage() → processes SDK messages
   - handleArbiterOutput() → adds to state conversationLog, calls onArbiterMessage callback, calls onDebugLog callback
   - handleOrchestratorMessage() → processes orchestrator SDK messages
   - handleOrchestratorOutput() → adds to state conversationLog, calls onOrchestratorMessage callback, calls onDebugLog callback

2. **State.ts (conversation history)**
   - AppState.conversationLog: Message[] array with speaker, text, timestamp
   - addMessage() helper mutates state directly

3. **TUI Callbacks (src/tui/index.tsx, via React hooks)**
   - onHumanMessage: adds to React state, displays in ChatLog
   - onArbiterMessage: adds to React state, displays in ChatLog (yellow)
   - onOrchestratorMessage: adds to React state, displays in ChatLog (cyan)
   - onDebugLog: routes DebugLogEntry to LogbookOverlay component

## TUI Logbook Overlay (Ink React component)
- **Access**: Ctrl+O toggles LogbookOverlay component
- **Views**: Two modes toggled with 'D' key
  - Summary mode: Shows only messages with timestamps
  - Debug mode: Shows all entries including tools, context, mode changes, system events
- **Display**: Full-screen React component with border styling

## Context Tracking
**Context percentage calculation (router.ts)**
- MAX_CONTEXT_TOKENS = 200,000
- Calculated from SDK result messages: (input_tokens + cache_read_input_tokens + cache_creation_input_tokens) / 200000 * 100
- Never decreases: Math.max(newPercent, currentPercent) prevents backsliding
- Tracked separately: arbiterContextPercent, orchestratorContextPercent
- Updated via onContextUpdate callback

## Tool Use Events (router.ts, orchestrator.ts)
**PostToolUse Hook (orchestrator.ts)**
- Triggered after tool execution on Orchestrator
- Increments tool call count in toolCallCounts Map
- Updates state via updateOrchestratorTool()
- Calls onToolUse callback with tool name and count
- Calls onDebugLog with type:'tool', speaker:'Conjuring I', details {tool, count}
- Returns context warnings at 70% and 85% thresholds

## Debug Log Entry Type (router.ts)
```typescript
type DebugLogEntry = {
  type: 'message' | 'tool' | 'system';
  speaker?: string;  // 'arbiter', 'human', 'Conjuring I', etc.
  text: string;
  filtered?: boolean;  // For echo filtering
  details?: any;  // Extra data like {tool, count}
}
```

## Mode Changes
- Logged to state.mode: 'human_to_arbiter' | 'arbiter_to_orchestrator'
- onModeChange callback triggered
- Used for scene positioning (Arbiter moves between positions based on mode)

## Integration Points
1. Router spawns all logged events via callbacks
2. TUI.getRouterCallbacks() creates callback object with onDebugLog handler
3. ChatLog component displays messages with color-coded speakers
4. LogbookOverlay component displays debug entries (Ctrl+O to toggle)
**Files**: src/router.ts, src/tui/index.tsx, src/tui/components/ChatLog.tsx, src/tui/components/LogbookOverlay.tsx, src/state.ts, src/orchestrator.ts
---

### [18:09] [tui] Ink TileSceneArea ANSI Integration
**Details**: Package 6 of Ink migration: TileScene integration using raw ANSI escape sequences.

Key implementation details:
1. TileSceneArea component reserves 112-char space in Ink layout with an empty Box
2. Uses useStdout() to get write function for direct ANSI output
3. Writes tile scene using cursor positioning: \x1b[row;colH (1-indexed)
4. Tileset loaded asynchronously on mount via loadTileset()
5. Scene rendered via createScene() + renderScene() from scene.ts

Animation handled by useAnimation hook:
- Frame counter cycles 0-3 at 300ms intervals
- hopFrame toggles during first 3 seconds of work
- bubbleFrame uses variable timing after 3 seconds (400-1200ms on, 600-2000ms off)
- Activated by workingTarget: 'arbiter' | 'conjuring' | null

Scene state flow in App.tsx:
- sceneState passed to TileSceneArea via props
- Demo commands update sceneState (arbiter, spawn, demons, reset)
- arbiterPos: 0=near human, 1=center, 2=near cauldron
- demonCount: 0-5 demons spawned around campfire

The key insight is that Ink uses alternate screen buffer, so direct ANSI writes at column 1 work alongside Ink's React rendering on the right side.
**Files**: src/tui/components/TileSceneArea.tsx, src/tui/hooks/useAnimation.ts, src/tui/App.tsx
---

### [18:19] [architecture] Ink TUI Router Integration Pattern
**Details**: The Ink TUI uses a bridge pattern to connect React's declarative state with the Router's imperative callbacks:

1. **TUIBridge object** - Module-scoped holder for:
   - `inputCallback` - User's input handler from `onInput()`
   - `routerCallbacks` - React's RouterCallbacks from inside App
   - `actions` - TUIActions from useAppState hook
   - `waitingFor` - Current waiting state

2. **createTUI()** returns an imperative interface that:
   - `start()` - Renders Ink app with fullscreen-ink
   - `stop()` - Unmounts Ink instance
   - `getRouterCallbacks()` - Returns proxy callbacks that forward to React
   - `onInput(cb)` - Stores callback for input submission
   - `startWaiting/stopWaiting` - Updates bridge state + calls React

3. **App receives props:**
   - `initialState` - AppState from Router
   - `selectedCharacter` - Tile index
   - `onInputSubmit` - Callback to forward input to bridge
   - `onAppReady` - Called on mount with callbacks and actions
   - `getWaitingState` - Function to poll external waiting state

4. **Flow:**
   - App mounts → calls `onAppReady(routerCallbacks, actions)` 
   - Bridge stores callbacks/actions
   - Router calls `getRouterCallbacks()` → gets proxy object
   - Proxy forwards to stored React callbacks
   - React callbacks update state → triggers re-render
**Files**: src/tui/index.tsx, src/tui/App.tsx, src/tui/hooks/useAppState.ts, src/tui/hooks/useRouterCallbacks.ts
---

### [18:45] [gotcha] Ink clears raw ANSI writes on re-render
**Details**: When mixing raw ANSI escape sequence writes (via stdout.write) with Ink's React-based rendering:

PROBLEM:
- Ink uses logUpdate which calls ansiEscapes.eraseLines() before each render
- When output height >= terminal rows, Ink uses clearTerminal
- Any raw ANSI content written between Ink renders gets erased
- Symptoms: content shows briefly then disappears, or flashes on updates

ROOT CAUSE:
- Ink manages the entire terminal output and clears previous content
- useEffect hooks run after React render, then Ink may re-render again
- fullscreen-ink uses alternate screen buffer (\x1b[?1049h) but doesn't prevent clearing

SOLUTION:
- Use a continuous interval (e.g., 50ms) to re-render raw ANSI content
- Store render data in refs so the interval can access current values
- This "fights back" against Ink's clearing by constantly re-painting
- Also render immediately on state changes for responsiveness

IMPLEMENTATION PATTERN:
```tsx
const renderDataRef = useRef({ ...current values... });
renderDataRef.current = { ...updated values... };

const renderFn = useCallback(() => {
  const data = renderDataRef.current;
  // ... render to stdout ...
}, [stdout]);

useEffect(() => {
  if (!ready) return;
  renderFn();
  const id = setInterval(() => renderFn(), 50);
  return () => clearInterval(id);
}, [ready, renderFn]);
```
**Files**: src/tui/components/TileSceneArea.tsx, node_modules/ink/build/ink.js, node_modules/ink/build/log-update.js
---

