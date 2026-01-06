# Arbiter TUI Integration Architecture

The TUI is the primary integration point between the Router and user input. Built with Ink (React for CLIs) with pixel-art tile rendering.

## Initialization Flow (src/index.ts)

1. Create AppState via `createInitialState()`
2. Create TUI via `createTUI(state)`
3. Get RouterCallbacks from TUI via `tui.getRouterCallbacks()`
4. Create Router with state and callbacks
5. Wire user input: `tui.onInput()` → `router.sendHumanMessage()`
6. Start TUI first (takes terminal), then Router

## State Flow

- AppState is mutable, passed by reference to both TUI and Router
- Router updates state via mutation helpers (`updateArbiterContext`, `setMode`, etc.)
- TUI reads state in callbacks and re-renders affected components via React
- No state passed back from TUI - TUI is display-only

## Router Callbacks Contract

- `RouterCallbacks` interface defines what Router calls and when
- TUI implements all callback methods via `getRouterCallbacks()`
- Callbacks are fire-and-forget - no return values
- Callbacks update React state via the TUI bridge

## TUI Bridge Pattern

The Ink TUI uses a bridge pattern to connect React's declarative state with the Router's imperative callbacks:

### TUIBridge Object (module-scoped)

- `inputCallback` - User's input handler from `onInput()`
- `routerCallbacks` - React's RouterCallbacks from inside App
- `actions` - TUIActions from useAppState hook
- `waitingFor` - Current waiting state

### createTUI() Returns

- `start()` - Renders Ink app with fullscreen-ink
- `stop()` - Unmounts Ink instance
- `getRouterCallbacks()` - Returns proxy callbacks that forward to React
- `onInput(cb)` - Stores callback for input submission
- `startWaiting/stopWaiting` - Updates bridge state + calls React

### App Props

- `initialState` - AppState from Router
- `selectedCharacter` - Tile index
- `onInputSubmit` - Callback to forward input to bridge
- `onAppReady` - Called on mount with callbacks and actions
- `getWaitingState` - Function to poll external waiting state

### Flow

1. App mounts → calls `onAppReady(routerCallbacks, actions)`
2. Bridge stores callbacks/actions
3. Router calls `getRouterCallbacks()` → gets proxy object
4. Proxy forwards to stored React callbacks
5. React callbacks update state → triggers re-render

## Ink Integration

- React-based TUI with flexbox layout
- Components: TileSceneArea, ChatLog, StatusBar, InputBox, LogbookOverlay
- Hooks: useTerminalSize, useAppState, useRouterCallbacks, useAnimation, useScroll
- Full-screen mode via fullscreen-ink package

## Animation System

- useAnimation hook manages frame counter
- TileSceneArea renders pixel-art directly to stdout (bypassing Ink)
- Animations run on requestAnimationFrame-style timer

## Related Files

- src/index.ts
- src/router.ts
- src/state.ts
- src/tui/index.tsx
- src/tui/App.tsx
- src/tui/components/
- src/tui/hooks/
- src/tui/hooks/useAppState.ts
- src/tui/hooks/useRouterCallbacks.ts
