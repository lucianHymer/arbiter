# Knowledge Capture Session - 2026-01-05

### [05:52] [architecture] Arbiter TUI Integration Architecture
**Details**: The TUI is the primary integration point between the Router and user input. Key flow:

1. **Initialization** (src/index.ts):
   - Create AppState via createInitialState()
   - Create TUI via createTUI(state)
   - Get RouterCallbacks from TUI via tui.getRouterCallbacks()
   - Create Router with state and callbacks
   - Wire user input: tui.onInput() → router.sendHumanMessage()
   - Start TUI first (takes terminal), then Router

2. **State Flow**:
   - AppState is mutable, passed by reference to both TUI and Router
   - Router updates state via mutation helpers (updateArbiterContext, setMode, etc.)
   - TUI reads state in callbacks and re-renders affected components
   - No state passed back from TUI - TUI is display-only

3. **Router Callbacks are the Contract**:
   - RouterCallbacks interface defines what Router calls and when
   - TUI implements all callback methods via getRouterCallbacks()
   - Callbacks are fire-and-forget - no return values
   - Callbacks preserve animation state (waitingState in closure)

4. **Blessed Integration**:
   - LayoutElements encapsulates all blessed widgets
   - Screen holds everything, manages rendering
   - Textbox for input (handles submit/cancel/key events)
   - Boxes for title, conversation, status
   - Scrolling and mouse support via blessed properties
   - Full unicode, smart cursor, dock borders

5. **Animation System**:
   - Global state in render.ts (animationFrame counter)
   - TUI interval timer calls advanceAnimation() and renderStatus()
   - Campfire animations and gem sparkle use animation frame
   - Different animation speeds for arbiter vs orchestrator waiting
**Files**: src/index.ts, src/router.ts, src/state.ts, src/tui/index.ts, src/tui/layout.ts, src/tui/render.ts
---

