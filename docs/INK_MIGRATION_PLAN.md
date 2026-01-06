# Ink TUI Migration Plan

## Overview

Migrate from blessed to Ink (React for CLIs) to get:
- Native-feeling scroll (3 lines per wheel, J/K vim-style)
- Better React-based component model
- Fullscreen mode with alternate screen buffer
- Full control over scroll behavior (blessed hardcodes scroll at height/2)

## Target Layout

```
┌─────────────────────────┬─────────────────────────────────────────┐
│                         │                                         │
│                         │  Scrollable Chat Log                    │
│     TILE SCENE          │  - Mouse wheel: 3 lines                 │
│     112 chars wide      │  - J/K: 1 line up/down                  │
│     (7 tiles × 16px)    │  - Page Up/Down: viewport               │
│                         │                                         │
│     Full height         │  You: hello                             │
│     Left side           │  Arbiter: greetings, mortal             │
│                         │  Conjuring I: task complete             │
│                         │                                         │
│                         ├─────────────────────────────────────────┤
│                         │  Arbiter ████░░ 45%  Conjuring ██░░ 23% │
│                         ├─────────────────────────────────────────┤
│                         │  > input here_                          │
└─────────────────────────┴─────────────────────────────────────────┘
```

**Dimensions:**
- Scene: 112 chars wide (7 tiles × 16 chars) × full terminal height
- Chat: `(terminalWidth - 112)` wide × `(terminalHeight - statusHeight - inputHeight)`
- Status: 2-3 lines
- Input: 3-5 lines

## File Structure

```
src/tui/                       # Replace existing blessed code
├── App.tsx                    # Root component, layout orchestration
├── index.tsx                  # Entry point, render() call
├── components/
│   ├── ChatLog.tsx            # Scrollable message list
│   ├── StatusBar.tsx          # Context %, tool indicator
│   ├── InputBox.tsx           # Multiline input, Enter/Alt+Enter
│   ├── TileSceneArea.tsx      # Reserved space + raw ANSI render
│   └── LogbookOverlay.tsx     # Full-screen log view
├── hooks/
│   ├── useScroll.ts           # Scroll state, mouse/keyboard handlers
│   ├── useRouterCallbacks.ts  # Bridge to existing Router
│   ├── useAnimation.ts        # Animation frame for scene
│   └── useTerminalSize.ts     # Terminal dimensions
├── screens/
│   ├── CharacterSelect.tsx    # Port from existing
│   └── ForestIntro.tsx        # Port from existing
├── types.ts                   # Shared types
│
│   # Keep these (already working, pure logic):
├── tileset.ts                 # ✓ Keep as-is
├── scene.ts                   # ✓ Keep as-is
├── logbook.ts                 # ✓ Keep as-is
├── animations.ts              # ✓ Keep as-is (or adapt)
└── sprites.ts                 # ✓ Keep as-is
```

**Delete after migration:**
- `src/tui/index.ts` (old blessed entry)
- `src/tui/layout.ts` (blessed layout)
- `src/tui/render.ts` (blessed rendering)
- `src/tui/speech-bubble.ts` (if not needed)

## Key Technical Decisions

1. **Fullscreen mode:** Yes (alternate screen buffer via `fullscreen-ink`)
2. **Scroll speed:** 3 lines per wheel event
3. **J/K scrolling:** Yes (vim-style)
4. **Input behavior:** Enter=submit, Alt+Enter=newline
5. **Scene position:** Left side, 112 chars wide, full height
6. **Chat position:** Right side, fills remaining width

## Dependencies

**Add:**
```json
{
  "ink": "^5.0.1",
  "react": "^18.2.0",
  "@inkjs/ui": "^2.0.0",
  "fullscreen-ink": "^1.0.0"
}
```

**Remove:**
```json
{
  "blessed": "^0.1.81",
  "@types/blessed": "^0.1.25"
}
```

## Core Patterns

### Scroll Implementation

Ink doesn't have native scroll. We build it with `overflow="hidden"` + negative margins:

```tsx
function useScroll(contentHeight: number, viewportHeight: number) {
  const [offset, setOffset] = useState(0);
  const maxScroll = Math.max(0, contentHeight - viewportHeight);

  const scrollBy = (lines: number) => {
    setOffset(prev => Math.max(0, Math.min(maxScroll, prev + lines)));
  };

  useInput((input, key) => {
    // Mouse wheel - 3 lines per event
    if (key.mouse?.action === 'wheeldown') scrollBy(3);
    if (key.mouse?.action === 'wheelup') scrollBy(-3);

    // J/K vim-style - 1 line
    if (input === 'j') scrollBy(1);
    if (input === 'k') scrollBy(-1);

    // Arrow keys - 1 line
    if (key.downArrow) scrollBy(1);
    if (key.upArrow) scrollBy(-1);

    // Page up/down - viewport height
    if (key.pageDown) scrollBy(viewportHeight);
    if (key.pageUp) scrollBy(-viewportHeight);
  });

  return { offset, scrollBy, maxScroll };
}
```

```tsx
// ChatLog component
<Box height={viewportHeight} overflow="hidden">
  <Box marginTop={-scrollOffset}>
    {messages.map(msg => <Text key={msg.id}>{msg.text}</Text>)}
  </Box>
</Box>
```

### Fullscreen Setup

```tsx
import {withFullScreen} from 'fullscreen-ink';

const ink = withFullScreen(<App />);
await ink.start();
await ink.waitUntilExit();
```

### Tile Scene (Raw ANSI)

```tsx
function TileSceneArea() {
  const {write} = useStdout();
  const {width, height} = useTerminalSize();

  useEffect(() => {
    // Scene is at left edge, position 1,1
    const rendered = renderScene(tileset, scene, workingTarget, hopFrame);
    const lines = rendered.split('\n');
    for (let i = 0; i < lines.length; i++) {
      write(`\x1b[${i + 1};1H${lines[i]}`);
    }
  }, [scene, hopFrame, width, height]);

  return <Box width={112} height="100%" />;
}
```

---

## Work Packages

### Package 1: Dependencies & Skeleton

**Goal:** Set up Ink, remove blessed, create skeleton

**Tasks:**
1. Update package.json:
   - Add: `ink`, `react`, `@inkjs/ui`, `fullscreen-ink`
   - Remove: `blessed`, `@types/blessed`
2. Update tsconfig.json for JSX:
   ```json
   {
     "compilerOptions": {
       "jsx": "react-jsx"
     }
   }
   ```
3. Create skeleton files:
   - `src/tui/App.tsx` - empty component
   - `src/tui/index.tsx` - fullscreen-ink entry point
4. Update `src/index.ts` to import from new entry point
5. Run `npm install`

**Acceptance:** `npm run dev` launches empty Ink fullscreen app, exits cleanly with Ctrl+C

**Files to create:**
- `src/tui/App.tsx`
- `src/tui/index.tsx`

**Files to modify:**
- `package.json`
- `tsconfig.json`
- `src/index.ts`

---

### Package 2: Core Layout

**Goal:** Implement the flexbox layout structure

**Tasks:**
1. Implement `App.tsx` with layout:
   ```tsx
   <Box flexDirection="row" width="100%" height="100%">
     <Box width={112} height="100%">
       {/* TileScene - left side, full height */}
     </Box>
     <Box flexDirection="column" flexGrow={1}>
       <Box flexGrow={1}>{/* ChatLog */}</Box>
       <Box height={3}>{/* StatusBar */}</Box>
       <Box height={5}>{/* InputBox */}</Box>
     </Box>
   </Box>
   ```
2. Create `src/tui/hooks/useTerminalSize.ts`:
   - Wrap `useStdout` to get dimensions
   - Return `{width, height}`
3. Create placeholder components with colored backgrounds for visual debugging

**Acceptance:** Layout shows correct proportions (112 left, rest right), resizes properly

**Files to create:**
- `src/tui/hooks/useTerminalSize.ts`
- `src/tui/components/` directory

**Files to modify:**
- `src/tui/App.tsx`

---

### Package 3: Scrollable ChatLog

**Goal:** Implement the scrollable chat with good scroll behavior

**Tasks:**
1. Create `src/tui/hooks/useScroll.ts`:
   - `scrollOffset` state
   - `scrollBy(lines)` with bounds checking
   - Mouse wheel: ±3 lines
   - J/K keys: ±1 line
   - Arrow up/down: ±1 line
   - Page up/down: ±viewport height
   - Home/End: jump to top/bottom
2. Create `src/tui/components/ChatLog.tsx`:
   - Accept `messages: Message[]` prop
   - `overflow="hidden"` container
   - `marginTop={-scrollOffset}` inner content
   - Speaker colors:
     - Human: green
     - Arbiter: yellow
     - Conjuring I/II/etc: cyan
3. Auto-scroll to bottom on new message (unless user scrolled up)
4. Optional: scroll indicator when not at bottom

**Acceptance:**
- Messages scroll at 3 lines per wheel event
- J/K scrolls 1 line
- Auto-scrolls on new message
- Doesn't auto-scroll if user manually scrolled up

**Files to create:**
- `src/tui/hooks/useScroll.ts`
- `src/tui/components/ChatLog.tsx`

**Reference:** Port message rendering from `src/tui/index.ts` callbacks (onHumanMessage, onArbiterMessage, onOrchestratorMessage)

---

### Package 4: InputBox

**Goal:** Multiline input with Enter=submit, Alt+Enter=newline

**Tasks:**
1. Create `src/tui/components/InputBox.tsx`:
   - Controlled `value` state
   - Cursor position tracking
   - Key handling:
     - Enter: call `onSubmit(value)`, clear input
     - Alt+Enter (escape sequence `\x1b\r`): insert newline
     - Escape: clear input
     - Backspace: delete character
     - Arrow keys: move cursor (if implementing cursor movement)
   - Visual cursor (underscore or block)
   - Multi-line display (show up to 5 lines, scroll if more)
   - Border with "> " label
2. Focus management - input captures keys when active

**Acceptance:**
- Can type text
- Enter submits and clears
- Alt+Enter inserts newline
- Escape clears
- Visual feedback for cursor

**Files to create:**
- `src/tui/components/InputBox.tsx`

**Reference:** Input handling from `src/tui/index.ts` setupInputHandling()

---

### Package 5: StatusBar

**Goal:** Display context percentages and tool info

**Tasks:**
1. Create `src/tui/components/StatusBar.tsx`:
   - Props: `arbiterContext`, `orchestratorContext`, `orchestratorNumber`, `currentTool`, `toolCount`, `waitingState`
   - Progress bar rendering:
     - Green: <50%
     - Yellow: 50-80%
     - Red: >80%
     - Characters: █ (filled), ░ (empty)
   - Layout:
     - Line 1: Arbiter context bar
     - Line 2: Orchestrator context bar (if active) or waiting message
     - Line 3: Tool indicator + [Ctrl+O] Logbook hint
   - Waiting state animations:
     - "Awaiting the Arbiter..." with animated dots
     - "The conjuring works..." with animated dots
2. Port `renderProgressBar` logic from `src/tui/render.ts`

**Acceptance:**
- Shows context percentages with colored bars
- Shows tool name and count when active
- Animated dots when waiting

**Files to create:**
- `src/tui/components/StatusBar.tsx`

**Reference:** Port from `src/tui/render.ts` renderStatus()

---

### Package 6: TileScene Integration

**Goal:** Render the tile scene in the left panel using raw ANSI

**Tasks:**
1. Create `src/tui/components/TileSceneArea.tsx`:
   - Fixed 112-char-wide Box
   - Use `useStdout()` to get `write` function
   - Calculate absolute screen position (always column 1)
   - On scene change: write ANSI escape sequences to position and render
   - Clear area before redraw if needed
2. Create `src/tui/hooks/useAnimation.ts`:
   - Animation frame counter
   - Interval timer (300ms)
   - `hopFrame` and `bubbleFrame` state
   - Cleanup on unmount
3. Scene state management:
   - `arbiterPos` (0, 1, or 2)
   - `demonCount` (0-5)
   - `workingTarget` ('arbiter' | 'conjuring' | null)
   - `selectedCharacter` (tile index)
4. Wire up existing modules:
   - `tileset.ts` - loadTileset(), renderScene()
   - `scene.ts` - createScene(), SceneState
5. Handle terminal resize: recalculate and re-render

**Acceptance:**
- Tile scene appears in left 112 columns
- Arbiter, campfire, demons render correctly
- Hop animation works when waiting
- Bubble animation works after 3 seconds
- Survives terminal resize

**Files to create:**
- `src/tui/components/TileSceneArea.tsx`
- `src/tui/hooks/useAnimation.ts`

**Reference:**
- Port rendering from `src/tui/index.ts` doRenderTileScene()
- Keep using `src/tui/scene.ts` and `src/tui/tileset.ts` as-is

---

### Package 7: Router Integration

**Goal:** Connect Ink TUI to existing Router, matching the old interface

**Tasks:**
1. Create `src/tui/hooks/useAppState.ts`:
   - All TUI state in one place:
     - `messages: Message[]`
     - `arbiterContext: number`
     - `orchestratorContext: number | null`
     - `orchestratorNumber: number | null`
     - `currentTool: string | null`
     - `toolCount: number`
     - `waitingState: 'none' | 'arbiter' | 'orchestrator'`
     - `sceneState: SceneState`
   - Reducer or setState functions for updates
2. Create `src/tui/hooks/useRouterCallbacks.ts`:
   - Return `RouterCallbacks` object
   - Each callback updates app state:
     - `onHumanMessage(text)` → add message
     - `onArbiterMessage(text)` → add message
     - `onOrchestratorMessage(num, text)` → add message
     - `onContextUpdate(arbiter, orch)` → update context
     - `onToolUse(tool, count)` → update tool state
     - `onModeChange(mode)` → update scene arbiterPos
     - `onWaitingStart/Stop` → update waitingState
     - `onOrchestratorSpawn(num)` → update scene demonCount
     - `onOrchestratorDisconnect()` → reset demons
     - `onDebugLog(entry)` → forward to logbook
3. Export TUI interface from `src/tui/index.tsx`:
   ```tsx
   export interface TUI {
     start(): void;
     stop(): void;
     getRouterCallbacks(): RouterCallbacks;
     onInput(callback: (text: string) => void): void;
     startWaiting(waitingFor: 'arbiter' | 'orchestrator'): void;
     stopWaiting(): void;
   }

   export function createTUI(state: AppState, selectedCharacter?: number): TUI
   ```
4. Update `src/index.ts` to use new TUI (should be drop-in replacement)

**Acceptance:**
- `createTUI` returns object matching existing interface
- Full message flow works: human input → Router → Arbiter → display
- Context updates show in status bar
- Tool use shows in status bar
- Scene updates (arbiter position, demons) work

**Files to create:**
- `src/tui/hooks/useAppState.ts`
- `src/tui/hooks/useRouterCallbacks.ts`

**Files to modify:**
- `src/tui/index.tsx`
- `src/index.ts`

**Reference:** Match interface from old `src/tui/index.ts`

---

### Package 8: LogbookOverlay

**Goal:** Toggle-able full-screen logbook view

**Tasks:**
1. Create `src/tui/components/LogbookOverlay.tsx`:
   - Full-screen Box (100% width, 100% height)
   - Renders over everything when visible
   - Hidden by default (`visible` state)
   - Title bar: "LOGBOOK [SUMMARY]" or "LOGBOOK [DEBUG]"
   - Scrollable content area (reuse useScroll)
   - Hint: "[D] Toggle Mode  [Ctrl+O] Close"
2. Key bindings:
   - Ctrl+O: toggle visibility
   - D: toggle between summary/debug mode
   - Escape: close
   - J/K/arrows: scroll
3. Wire up existing `Logbook` class from `src/tui/logbook.ts`
4. Display entries from logbook.getCurrentView()

**Acceptance:**
- Ctrl+O shows/hides logbook
- D toggles between summary and debug mode
- Content is scrollable
- Escape closes

**Files to create:**
- `src/tui/components/LogbookOverlay.tsx`

**Reference:** Port from old `src/tui/layout.ts` createLogbookOverlay() and `src/tui/index.ts` setupLogbookToggle()

---

### Package 9: Entry Screens

**Goal:** Port character selection and forest intro screens to Ink

**Tasks:**
1. Create `src/tui/screens/CharacterSelect.tsx`:
   - Display 8 character options (tiles 190-197)
   - Arrow keys to select
   - Enter to confirm
   - Return selected character tile index
2. Create `src/tui/screens/ForestIntro.tsx`:
   - Animated scene showing character walking through forest
   - Auto-advance after animation completes
3. Update `src/tui/index.tsx` with screen flow:
   - Start with character select
   - Show forest intro
   - Then show main TUI
4. Export async function that handles full flow

**Acceptance:**
- Character select shows, can choose character
- Forest intro plays with selected character
- Transitions to main TUI smoothly

**Files to create:**
- `src/tui/screens/CharacterSelect.tsx`
- `src/tui/screens/ForestIntro.tsx`

**Reference:** Port from `src/tui/screens/character-select.ts` and `src/tui/screens/forest-intro.ts`

---

### Package 10: Cleanup

**Goal:** Remove old code, final polish

**Tasks:**
1. Delete old blessed files:
   - `src/tui/layout.ts`
   - `src/tui/render.ts`
   - `src/tui/speech-bubble.ts`
   - Old `src/tui/index.ts` (if separate from new one)
   - `src/tui/screens/character-select.ts`
   - `src/tui/screens/forest-intro.ts`
2. Remove any unused imports
3. Verify no blessed references remain: `grep -r "blessed" src/`
4. Run full test:
   - `npm run dev` - main app works
   - `npm run test:headless` - headless test passes
   - `npm run demo:scene` - scene demo works (if keeping)
5. Update any documentation referencing blessed

**Acceptance:**
- No blessed code remains
- All tests pass
- App runs correctly end-to-end

**Files to delete:**
- `src/tui/layout.ts`
- `src/tui/render.ts`
- `src/tui/speech-bubble.ts`
- `src/tui/screens/character-select.ts`
- `src/tui/screens/forest-intro.ts`

---

## Execution Order

```
Package 1 (Dependencies & Skeleton)
       ↓
Package 2 (Core Layout)
       ↓
   ┌───┴───┬───────┬───────┐
   ↓       ↓       ↓       ↓
Pkg 3   Pkg 4   Pkg 5   Pkg 6
(Chat)  (Input) (Status)(Scene)
   └───┬───┴───────┴───────┘
       ↓
Package 7 (Router Integration)
       ↓
   ┌───┴───┐
   ↓       ↓
Pkg 8   Pkg 9
(Log)   (Screens)
   └───┬───┘
       ↓
Package 10 (Cleanup)
```

**Parallelization:**
- Packages 3, 4, 5, 6 can run in parallel after Package 2
- Packages 8, 9 can run in parallel after Package 7

---

## Testing Commands

```bash
# After Package 1
npm run dev  # Should show empty fullscreen, exit with Ctrl+C

# After Package 2
npm run dev  # Should show layout with colored placeholders

# After Packages 3-6
npm run dev  # Should show all components, scroll works, scene renders

# After Package 7
npm run dev  # Full app works, can chat with Arbiter

# After Package 10
npm run dev           # Everything works
npm run test:headless # Headless test passes
grep -r "blessed" src/  # No results
```
