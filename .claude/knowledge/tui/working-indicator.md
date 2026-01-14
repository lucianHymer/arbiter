# TUI Transient Working Indicator Pattern

Implementation strategy for transient tool indicators in the terminal-kit based TUI.

## Current TUI Architecture

- Located in `/workspace/project/src/tui/tui-termkit.ts` (1507 lines)
- Uses minimal redraws pattern (Strategy 5) with RedrawTracker for efficiency
- Animation interval: ANIMATION_INTERVAL=250ms
- Callback bridge connects router messages to TUI state

## Current Tool Display System

- `onToolUse` callback receives `(tool: string, count: number)`
- Currently displays in status bar: `${state.currentTool} (${state.toolCallCount})`
- Tool persists until orchestrator disconnects (`onOrchestratorDisconnect`)
- No auto-clear mechanism exists

## Existing Working Indicator Pattern

Lines 423-440 show EXISTING working indicator:
- Only shows when `state.waitingFor !== 'none'`
- Blinking effect: toggles on/off based on `state.blinkCycle % 2`
- Shows "Arbiter is working...", "Orchestrator is working..." with dots animation
- Uses dim color + arbiter/orchestrator colors
- Renders in chat area, not status bar

## Animation System

- `state.animationFrame` cycles 0-7 on 250ms interval
- `state.blinkCycle` increments every full animation cycle (~2 seconds)
- Dots animation: `.repeat((state.blinkCycle % 3) + 1)` produces 1-3 dots
- Animation loop forces redraw of tiles/chat/status only when needed

## Implementation Options

### Option A: Extend Status Bar (Simple)
- Keep tool in status bar with pulse animation
- Add timeout to auto-clear after 5 seconds of inactivity
- Use blinking pattern similar to working indicator
- No major changes to chat layout

### Option B: Chat-based Indicator (Comprehensive)
- Add separate transient tool message in chat area
- Show: `⸬ ${tool_name} ⸬` with pulse animation
- Auto-clear after 5 seconds
- More visible than status bar
- Requires tracking lastToolTime + auto-clear timeout

### Option C: Extend Working Indicator (Hybrid)
- Enhance existing working indicator to show tool name
- When waiting: show "Arbiter is working: tool_name"
- Auto-clear both waiting and tool together
- Minimal changes, leverages existing patterns

## Key Implementation Points

1. **Timeout Tracking**: Add `lastToolTime: number` to TUIState
2. **Auto-clear Logic**: Check in animation loop - if 5s passed since tool was set, clear it
3. **Pulse Animation**: Use existing `state.animationFrame` % pattern
4. **Callback Integration**: Tool info flows via existing onToolUse callback
5. **State Management**: Tool state persists but clears on timeout

## Why Status Bar is Limiting

- Status bar info is always visible but can feel cluttered
- Tool info gets overwritten by context/waiting indicators
- No natural animation space for pulse
- Chat-based indicator would be more prominent for transient events

## Related Files

- src/tui/tui-termkit.ts
- src/router.ts
- src/tui/types.ts
