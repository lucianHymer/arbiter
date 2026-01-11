# Requirements Selection Flow with onRequirementsReady Callback

The requirements selection happens INSIDE the main TUI as an overlay, not as a separate pre-screen.

## Flow Timing

1. TUI starts, entrance sequence begins
2. Human walks to position (400ms)
3. Human hops (900ms), Arbiter hops (1800ms)
4. At 2800ms: if no CLI arg, show requirements prompt overlay
5. User interacts with overlay (Y/N, file picker)
6. On file selection: `onRequirementsReady` callback fires → router starts
7. Scroll tile appears, arbiter walks to final position
8. Messages queued until `entranceComplete = true`

## State Values

```typescript
state.requirementsOverlay: 'none' | 'prompt' | 'picker' | 'rat-transform'
```

## Key Patterns

### Preventing Scene Redraws
- `requirementsTilesDrawn` flag prevents re-rendering scene on each keystroke
- All draw functions check `state.requirementsOverlay !== 'none'` to skip during overlay

### Callback Interface
```typescript
// TUI interface
onRequirementsReady(callback: (path: string | null) => void)

// In index.ts - wait for selection before starting router
tui.onRequirementsReady((path) => {
  // Start router with requirements path
});
```

## Message Queueing

Messages received before `entranceComplete = true` are queued and displayed after the entrance animation finishes.

## Related Files

- src/tui/tui-termkit.ts
- src/index.ts
