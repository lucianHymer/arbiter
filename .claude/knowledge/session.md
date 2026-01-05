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

### [19:04] [tui] Tile-based TUI renderer implementation
**Details**: Built a working tile-based renderer using Jerom 16x16 Fantasy Tileset.

Key findings:
- True color ANSI codes work (\x1b[48;2;R;G;Bm for bg, \x1b[38;2;R;G;Bm for fg)
- 256-color ANSI does NOT work properly
- Blessed does NOT pass through ANSI codes - must use process.stdout.write() directly
- Half-block technique: Use ▄ character with bg=top pixel, fg=bottom pixel
- Each 16×16 tile = 16 chars wide × 8 rows tall
- Alpha threshold = 1 (pixels with alpha < 1 are transparent)
- Tiles < 80 have own backgrounds, tiles >= 80 must composite on grass (tile 50)
- Focus overlay is tile 270 - corner brackets to show active speaker
- Scene is 7×6 tiles (112 chars × 48 rows)
- Don't clear screen on animation frames (causes flashing) - just cursor home and overwrite

Working demos:
- npm run test:tiles:raw - all tiles at various scales
- npm run demo:scene - animated unified scene with arbiter walking, demons spawning, focus overlay
**Files**: src/tui/tile-scene-demo.ts, src/tui/tile-test-raw.ts, docs/tui-tile-renderer-implementation.md, docs/TILE_TUI_INTEGRATION_PROMPT.md
---

### [19:59] [architecture] Message routing bug - Arbiter echo problem
**Details**: **BUG IDENTIFIED:** Arbiter echoing orchestrator messages with "Human: Orchestrator I: ..." prefixes.

**Root Cause in router.ts:**

1. `handleOrchestratorOutput()` (lines 437-453):
   - Correctly calls `onOrchestratorMessage(orchNumber, text)` → TUI shows "Conjuring I: text"
   - BUT ALSO calls `await this.sendToArbiter(\`${orchLabel}: ${text}\`)` which sends to Arbiter

2. `sendToArbiter()` creates a new SDK query with the orchestrator's message as input

3. Arbiter receives "Orchestrator I: text" and processes it as a user message, then responds

4. `handleArbiterOutput()` (lines 418-431):
   - Always calls `onArbiterMessage(text)` → TUI shows "Arbiter: text"
   - The Arbiter's response often echoes or acknowledges the orchestrator message

**The design intention (from arbiter.ts system prompt lines 69-83):**
- "Once you spawn an Orchestrator, become SILENT"
- "DO NOT: Add commentary or narration while the Orchestrator works"
- "Wait. Watch. The Orchestrator will report when their work is done."

**BUT:** The architecture forces Arbiter responses through onArbiterMessage callback regardless of mode.

**Fix needed:** In `handleArbiterOutput()`, when mode is "arbiter_to_orchestrator", suppress the `onArbiterMessage` callback unless Arbiter is actually saying something meaningful (not just forwarding/echoing).

Alternative fixes:
1. Check if Arbiter's text is just echoing/acknowledging orchestrator and skip the callback
2. Only call onArbiterMessage when mode is "human_to_arbiter"
3. Modify the design so Arbiter doesn't respond when receiving orchestrator messages (harder)
**Files**: src/router.ts, src/arbiter.ts, src/tui/index.ts
---

### [20:09] [architecture] Hierarchical AI orchestration - context management design
**Details**: The Arbiter is a hierarchical AI orchestration system that extends effective context by managing a chain of Claude sessions.

**The Core Insight:**
- Arbiter keeps Orchestrators on task
- Orchestrators keep their Subagents on task
- Each layer has ~200k context window
- Top level (Arbiter) holds the vision and problem understanding
- Lower levels do detailed work without losing the forest for the trees

**Why This Beats Serial Chaining:**
Serial handoffs lose context and vision. No one stays on task. The Arbiter pattern maintains an "overarching person" who has the full vision in one context window and keeps everyone aligned.

**How spawn_orchestrator MCP Tool Works:**
1. Tool defined with Claude Agent SDK's `tool()` helper + Zod schema
2. Registered as MCP server with Arbiter's query session
3. Claude (the AI) decides to call it via standard tool_use mechanism
4. Handler is async - stores prompt in `pendingOrchestratorPrompt`
5. After Arbiter turn completes, Router spawns the Orchestrator session
6. This is EVENT-DRIVEN with callbacks, NOT a state machine

**Flow:**
Human → Arbiter (manager, MCP tools) → Orchestrators (workers) → Subagents (do actual work)

**Key Files:**
- src/arbiter.ts: MCP tool definitions (spawn_orchestrator, disconnect_orchestrators)
- src/router.ts: Message routing, session management, deferred spawning
- src/orchestrator.ts: Orchestrator session with full tools + blocking subagents
**Files**: src/arbiter.ts, src/router.ts, src/orchestrator.ts
---

### [21:26] [architecture] Arbiter UI model - each other's users
**Details**: The UI is NOT relaying messages between sessions. It's showing THE ARBITER'S CONVERSATION with its "user" correctly labeled.

**Main Chat = Arbiter's perspective:**
- At first, the human is the Arbiter's user → shows as "You:"
- Once orchestrator spawned, they become EACH OTHER'S USERS:
  - Orchestrator is the user of Arbiter → shows as "Conjuring I:"
  - Arbiter is the user of Orchestrator (watching/guiding)
- "Arbiter:" = Arbiter's responses to whoever is its current user

**This is NOT message relaying.** It's:
1. Human talks to Arbiter (human = user)
2. Arbiter spawns orchestrator → they hook up as each other's users
3. Now orchestrator talks to Arbiter (orchestrator = user)
4. UI just shows Arbiter's chat with correct user labels

**Debug Log = ALL raw SDK messages:**
- Both Arbiter session AND active Orchestrator session
- Every message flowing through the SDK
- Properly labeled by source session
- NOT filtered or processed versions
**Files**: src/router.ts, src/tui/index.ts
---

### [22:15] [architecture] Router refactor - remove text tagging, keep forwarding
**Details**: CRITICAL: The forwarding of messages between Arbiter and Orchestrator is CORRECT and MUST STAY.

The PROBLEM is TEXT TAGGING:
- `"Orchestrator I: " + text` when forwarding to Arbiter - BAD
- `"Human: " + text` when forwarding human messages - BAD
- Echo filtering as band-aid - BAD

The FIX:
- Keep forwarding (that's the whole point!)
- Remove text tags - just forward raw text
- Remove echo filtering - let them figure it out
- Track message source via mode, not text parsing
- spawn_orchestrator has no prompt - orchestrator introduces itself

See docs/HANDOFF-router-refactor.md for full implementation details.
**Files**: src/router.ts, docs/HANDOFF-router-refactor.md
---

