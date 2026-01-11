### [00:38] [workflow] Sound Integration Requirements for Arbiter TUI
**Details**: The project already has a /workspace/project/sounds/ directory with 8 WAV files: death.wav, footstep.wav, jump.wav, magic.wav, menu-left.wav, menu-right.wav, menu-select.wav, quick-notice.wav. Sound integration requires creating a sound.ts module following the tileset.ts pattern (load sounds from assets directory, cache them, provide playback functions). No audio dependencies exist in package.json - will need to add a package like 'play-sound', 'node-wav', or platform-specific audio libraries. Audio playback should be integrated into: (1) TitleScreen keyboard handler (line 136-146) - play sound on any key; (2) CharacterSelect keyboard navigation (lines 236-251) - menu-left/right sounds on arrow keys, menu-select on ENTER; (3) ForestIntro keyboard movement (lines 942-1017) - footstep sound on arrow key movement, death.wav on death, jump.wav on successful exit; (4) tui-termkit.ts addMessage() function (line 928-957) - play quick-notice.wav when messages are added; (5) Hop animation system (lines 1391-1447) - play jump.wav during hop animation frames; (6) Demon spawn sequence (lines 1557-1607) - play magic.wav when demons spawn or during startSummonSequence(); (7) Arbiter walk animation (lines 1509-1546) - play footstep.wav for each step during animateArbiterWalk().
**Files**: src/tui/tileset.ts, src/tui/tui-termkit.ts, src/tui/screens/TitleScreen-termkit.ts, src/tui/screens/CharacterSelect-termkit.ts, src/tui/screens/ForestIntro-termkit.ts, src/tui/scene.ts
---

### [14:24] [gotcha] Avoid TypeScript "as" casts and "any" types
**Details**: TypeScript `as` casts and `any` types bypass type checking and hide bugs. The SDK hooks didn't work because we returned `object` and cast with `as Options["hooks"]` - TypeScript couldn't verify the structure was wrong.

Instead of:
- `function foo(): object` → use actual return type
- `x as SomeType` → fix the actual types
- `any` → use `unknown` and narrow with type guards

The SDK's types are correct - when we lie to the compiler with `as`, it can't help us.
**Files**: src/arbiter.ts, src/orchestrator.ts, src/router.ts
---

### [17:07] [gotcha] Requirements overlay clearing approach
**Details**: The requirements overlay in tui-termkit.ts uses term.clear() to clear the entire screen before drawing. A previous implementation tried to manually fill the chat area with black background using ANSI escape codes, but this was overly complex and had coordinate alignment issues (hardcoded sceneWidth=112 vs actual chatAreaX=115). The simplified approach just relies on term.clear() and draws only the scene - the chat area stays naturally cleared/empty. The guards in drawTiles() and drawChat() (checking state.requirementsOverlay !== 'none') prevent any subsequent redraws from overwriting the cleared state.
**Files**: src/tui/tui-termkit.ts
---

### [17:53] [tui] Reusable renderMessagePanel for tile-bordered dialogs
**Details**: Created a reusable `renderMessagePanel(tileset, textLines, widthTiles, heightTiles)` function for RPG-style tile-bordered message panels.

Key features:
- Uses dialogue tiles 38/39/48/49 for corners
- Supports variable height (2+ tiles) with proper vertical borders
- Middle rows use bottom-half of top corner tiles (pixel rows 8-15) with modulo to repeat pattern
- Text automatically centered within interior area
- Helper function `createMiddleRowBorders()` handles vertical border segments

Dimensions: Each tile = 16 chars wide × 8 char rows tall
- 2 tiles = 16 char rows (small prompts)
- 3 tiles = 24 char rows (file pickers)
- 4+ tiles = 32+ char rows (long content)

Text area leaves 2 rows at top/bottom for borders.

Used for: requirements prompt, file picker, rat transformation message.
**Files**: src/tui/tui-termkit.ts
---

### [17:53] [architecture] Requirements selection flow with onRequirementsReady callback
**Details**: The requirements selection happens INSIDE the main TUI as an overlay, not as a separate pre-screen.

Flow timing:
1. TUI starts, entrance sequence begins
2. Human walks to position (400ms)
3. Human hops (900ms), Arbiter hops (1800ms)
4. At 2800ms: if no CLI arg, show requirements prompt overlay
5. User interacts with overlay (Y/N, file picker)
6. On file selection: `onRequirementsReady` callback fires → router starts
7. Scroll tile appears, arbiter walks to final position
8. Messages queued until `entranceComplete = true`

Key patterns:
- `state.requirementsOverlay`: 'none' | 'prompt' | 'picker' | 'rat-transform'
- `requirementsTilesDrawn` flag prevents re-rendering scene on each keystroke
- All draw functions check `state.requirementsOverlay !== 'none'` to skip during overlay
- `onRequirementsReady(callback)` in TUI interface lets index.ts wait before starting router
**Files**: src/tui/tui-termkit.ts, src/index.ts
---

### [17:59] [input-handling] Terminal signal handling (Ctrl-C/Z/\)
**Details**: The TUI captures raw terminal input via `term.grabInput(true)`, intercepting control sequences before they become signals.

Key handling in main TUI:
- Ctrl-C (CTRL_C key event): Shows exit confirmation prompt
- Ctrl-Z (CTRL_Z key event): Suspends process via `process.kill(process.pid, 'SIGTSTP')` after restoring terminal state
- Ctrl-\ (CTRL_BACKSLASH key event): Passes through for dtach via `process.kill(process.pid, 'SIGQUIT')`

SIGCONT handler restores TUI state after suspend: re-enters fullscreen, re-enables grabInput, redraws.

Intro screens (TitleScreen, CharacterSelect, ForestIntro, GitignoreCheck) exit on Ctrl-C/Z but pass through Ctrl-\ for dtach.
**Files**: src/tui/tui-termkit.ts, src/tui/screens/TitleScreen-termkit.ts, src/tui/screens/CharacterSelect-termkit.ts, src/tui/screens/ForestIntro-termkit.ts, src/tui/screens/GitignoreCheck-termkit.ts
---

