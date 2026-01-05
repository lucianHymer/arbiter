# TUI Redesign: RPG-Style Terminal Interface

## Vision

Transform the Arbiter TUI from a boring chat interface into an **old-school RPG-style terminal experience**. Think Zelda, roguelikes, or classic JRPGs - but in ASCII art.

**The Scene**: A circle of wizards (Orchestrators) gathered around a magical campfire. The Arbiter is a messenger who walks back and forth between You (the human, off-screen left) and the wizard council. The campfire burns and crackles as work happens.

## Layout Overview

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║                              THE ARBITER                                         ║
║        OF THAT WHICH WAS, THAT WHICH IS, AND THAT WHICH SHALL COME TO BE         ║
╠══════════════════════════════════════════════════════════════════════════════════╣
║                                                                                  ║
║                           THE WIZARD'S CIRCLE                                    ║
║                                                                                  ║
║                              ╔═══╗   ╔═══╗                                       ║
║    ┌─────────────┐           ║ I ║   ║II ║                                       ║
║    │ Build auth  │  ◆        ╚═══╝   ╚═══╝                                       ║
║    │ system...   │ ╱█╲    (  * )                                                ║
║    └─────────────┘ ███      \│/    ╔═══╗                                        ║
║         ◄────      █ █       🔥     ║III║                                        ║
║       ARBITER              FIRE    ╚═══╝                                        ║
║      walks to you                                                                ║
║                                                                                  ║
╠══════════════════════════════════════════════════════════════════════════════════╣
║  Arbiter 12% ████░░░░  │  Wizard I: 34% ███████░░  │  ◈ Edit(7)   [Tab] Logbook  ║
╠══════════════════════════════════════════════════════════════════════════════════╣
║ > Your input here                                                                ║
╚══════════════════════════════════════════════════════════════════════════════════╝
```

## The Concept

1. **You (Human)** - Off-screen left. Your speech bubbles come from the left edge.

2. **The Arbiter** - Walks back and forth:
   - When talking to you: Arbiter is on the LEFT, facing left, speech bubble visible
   - When talking to wizards: Arbiter walks to the RIGHT, joins the circle

3. **The Wizard Circle** - Orchestrators are wizards gathered around a campfire:
   - Each wizard has a number (I, II, III, etc.)
   - They stand in a semi-circle around the fire
   - When a new wizard is summoned, they "materialize" into the circle

4. **The Campfire** - Center of the wizard circle:
   - Animated flames (the "working" indicator)
   - Burns brighter/faster when subagents are active
   - Calm/dim when idle

## Character Sprites

### The Arbiter (Center Stage)
Ancient, imposing, mysterious. Always present.

```
     ◆
    ╱█╲
   ░███░
    ▓█▓
    ███
   ▀▀ ▀▀
  ARBITER
```

Alternate (simpler):
```
    ◆
   ╱█╲
   ███
   █ █
```

### The Human (Left Side)
Simple mortal. Shows when speaking.

```
    o
   /█\
   / \
 MORTAL
```

Or just show speech bubbles from the left edge without a sprite.

### Orchestrator (Right Side)
Summoned servants. Can stack vertically (up to 3 visible).

```
  ╔═══╗
  ║◇◇◇║
  ║███║
  ║▀ ▀║
  ╚═══╝
ORCH I
```

When multiple:
```
  ╔═══╗  ╔═══╗
  ║◇◇◇║  ║◇◇◇║
  ║███║  ║███║
  ╚═══╝  ╚═══╝
 ORCH I  ORCH II
```

### Subagent (Small, appears briefly)
When an orchestrator spawns a subagent, show a tiny helper.

```
 ·◦·
 ▪▫▪
```

## Speech Bubbles

Speech bubbles appear above or beside the speaking character.

### Arbiter Speaking (bubble on right of Arbiter)
```
                    ┌─────────────────────────────────┐
                    │ What task do you bring before   │
     ◆              │ me, mortal?                     │
    ╱█╲─────────────┤                                 │
   ░███░            └─────────────────────────────────┘
    ▓█▓
```

### Human Speaking (bubble from left edge)
```
┌──────────────────────────┐
│ I need you to build an   │
│ authentication system    │──────►
└──────────────────────────┘
```

### Orchestrator Speaking (bubble on left of Orchestrator)
```
┌───────────────────────────┐
│ I'll begin by exploring   │    ╔═══╗
│ the codebase structure... ├────║◇◇◇║
└───────────────────────────┘    ║███║
                                 ╚═══╝
```

## Animations

### Spawning an Orchestrator
When Arbiter calls `spawn_orchestrator`:

1. Arbiter turns toward right side
2. New orchestrator "materializes" on the right (fade in with ░▒▓█)
3. Speech bubble: "Orchestrator I awakens."

```
Frame 1:     Frame 2:     Frame 3:
   ◆            ◆            ◆        ╔═══╗
  ╱█╲──►       ╱█╲──►       ╱█╲──────║◇◇◇║
  ███          ███          ███       ║███║
                    ░░░      ▒▒▒      ╚═══╝
```

### Orchestrator Working
While an orchestrator is active, show a simple animation:

```
Frame 1: ◇◇◇    Frame 2: ◆◇◇    Frame 3: ◇◆◇    Frame 4: ◇◇◆
```

### Loading/Thinking
Animated dots in status bar:
```
Working.    Working..    Working...    Working.
```

## Status Bar

Always visible at bottom above input:

```
║ Arbiter: 12% ████░░░░░░ │ Orch I: 34% ███████░░░ │ ◈ Edit (7) │ Working... ║
```

Components:
- Arbiter context % with bar
- Current orchestrator context % with bar (if active)
- Current tool + count (if orchestrator working)
- Animated status indicator

## Input Box

Multi-line capable, expands as you type:

```
╠══════════════════════════════════════════════════════════════════════════════════╣
║ > I need you to build an authentication system with OAuth support for Google     ║
║   and GitHub. Use Passport.js and JWT tokens with 48-hour expiry.                ║
╚══════════════════════════════════════════════════════════════════════════════════╝
```

Features:
- Line wrapping
- Scroll if very long
- Up arrow for history
- Clear visual prompt ">"

## Raw Log View (Toggle)

Press `Tab` or `L` to toggle a raw log overlay:

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║  RAW LOG                                                            [Tab: close] ║
╠══════════════════════════════════════════════════════════════════════════════════╣
║ [12:34:01] Human: I need an auth system                                          ║
║ [12:34:05] Arbiter: What providers? Token expiry?                                 ║
║ [12:34:15] Human: Google, GitHub. 48hr tokens.                                   ║
║ [12:34:18] Arbiter: [spawn_orchestrator] → Orchestrator I                        ║
║ [12:34:20] Orchestrator I: Beginning exploration...                              ║
║ [12:34:25] Orchestrator I: [Task] Spawned subagent: Explore codebase             ║
║ [12:34:45] Orchestrator I: [Bash] npm install passport                           ║
║ [12:35:02] Orchestrator I: [Edit] src/auth/passport.ts                           ║
║ ...                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════════╝
```

This shows:
- Timestamps
- All messages (human, arbiter, orchestrator)
- Tool calls with details
- Scrollable

## Technical Implementation

### Using Blessed

Blessed supports everything we need:
- `blessed.box()` for positioned elements
- `blessed.text()` for sprites (use `tags: true` for colors)
- `blessed.log()` for scrollable raw log
- `blessed.textarea()` for better input
- `screen.render()` for updates
- `setInterval()` for animations

### Component Structure

```
src/tui/
├── index.ts          # Main TUI orchestration
├── screen.ts         # Screen setup, key bindings
├── stage.ts          # Stage area with characters
├── sprites.ts        # ASCII art definitions
├── speech-bubble.ts  # Speech bubble rendering
├── status-bar.ts     # Bottom status bar
├── input-box.ts      # Input handling
├── raw-log.ts        # Raw log overlay
└── animations.ts     # Animation helpers
```

### Sprites Module

```typescript
// sprites.ts
export const ARBITER = `
     ◆
    ╱█╲
   ░███░
    ▓█▓
    ███
   ▀▀ ▀▀
`.trim();

export const ARBITER_LABEL = "ARBITER";

export const ORCHESTRATOR = `
  ╔═══╗
  ║◇◇◇║
  ║███║
  ║▀ ▀║
  ╚═══╝
`.trim();

export const HUMAN = `
    o
   /█\\
   / \\
`.trim();

export const SUBAGENT = `
 ·◦·
 ▪▫▪
`.trim();
```

### Speech Bubble Helper

```typescript
// speech-bubble.ts
export function createSpeechBubble(text: string, maxWidth: number = 40): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if ((currentLine + ' ' + word).length > maxWidth - 4) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = currentLine ? currentLine + ' ' + word : word;
    }
  }
  if (currentLine) lines.push(currentLine);

  const width = Math.max(...lines.map(l => l.length)) + 4;
  const top = '┌' + '─'.repeat(width - 2) + '┐';
  const bottom = '└' + '─'.repeat(width - 2) + '┘';
  const middle = lines.map(l => '│ ' + l.padEnd(width - 4) + ' │');

  return [top, ...middle, bottom].join('\n');
}
```

### Animation Loop

```typescript
// animations.ts
let animationFrame = 0;

export function startAnimationLoop(screen: blessed.Screen, callback: () => void) {
  setInterval(() => {
    animationFrame = (animationFrame + 1) % 4;
    callback();
    screen.render();
  }, 250);
}

export function getOrchestratorGem(): string {
  const gems = ['◇◇◇', '◆◇◇', '◇◆◇', '◇◇◆'];
  return gems[animationFrame];
}

export function getLoadingDots(): string {
  const dots = ['.', '..', '...', '..'];
  return 'Working' + dots[animationFrame];
}
```

## State Integration

The TUI needs to react to:

1. **onHumanMessage** → Show human speech bubble, add to log
2. **onArbiterMessage** → Show arbiter speech bubble, add to log
3. **onOrchestratorMessage** → Show orchestrator speech bubble, add to log
4. **onContextUpdate** → Update status bar percentages
5. **onToolUse** → Update status bar tool indicator, add to log
6. **onModeChange** → Maybe visual indicator of who Arbiter is talking to
7. **onWaitingStart/Stop** → Animate loading indicator

## Color Scheme (Optional)

If we want colors (blessed supports them):

- **Arbiter**: Gold/yellow (`{yellow-fg}`)
- **Orchestrator**: Cyan (`{cyan-fg}`)
- **Human**: White/default
- **Borders**: Gray (`{gray-fg}`)
- **Status bar**: Green for good, yellow for warning, red for critical

## Implementation Order

1. **Phase 1: Layout** - Set up the screen regions (stage, status, input)
2. **Phase 2: Sprites** - Render static Arbiter sprite, basic positioning
3. **Phase 3: Speech Bubbles** - Show messages in bubbles
4. **Phase 4: Orchestrators** - Add/remove orchestrator sprites dynamically
5. **Phase 5: Animations** - Add the loading dots, gem animation
6. **Phase 6: Raw Log** - Add toggle overlay
7. **Phase 7: Polish** - Colors, transitions, edge cases

## Resolved Design Decisions

1. **Human**: No sprite. Speech bubbles come from off-screen left.
2. **Wizards**: Show up to 4-5 in the circle, then collapse to "Wizard I + N more"
3. **Log toggle**: `[Tab] Logbook` - old-school game style
4. **Colors**: Zelda-style colorful (gold, browns, greens, fire orange)
5. **Campfire**: Animated flames as the working indicator
6. **Arbiter movement**: Walks left (to human) or right (to wizard circle) based on who they're talking to

## Color Scheme (Zelda-Style)

```
- Arbiter: {yellow-fg} gold/yellow
- Wizards: {cyan-fg} cyan/blue robes
- Campfire: {red-fg}/{yellow-fg} animated orange/red/yellow
- Borders: {#8B4513-fg} brown (like wood)
- Title: {bold}{yellow-fg} gold
- Status bar: {green-fg} for OK, {yellow-fg} warning, {red-fg} critical
- Human speech: {white-fg} default
- [Tab] Logbook: {gray-fg} subtle hint
```

## Important: Permissions

The orchestrators spawn subagents that need permission bypass. Make sure:

```typescript
// In orchestrator session or anywhere subagents are spawned
permissionMode: 'bypassPermissions',
```

**README Warning**: This tool runs with full permissions and is designed for controlled environments. Do not run on systems with sensitive data you don't want AI agents to access.

## Reference: Current Files to Modify/Replace

```
src/tui/
├── index.ts      # Rewrite
├── layout.ts     # Rewrite
└── render.ts     # Rewrite
```

Keep the RouterCallbacks interface the same so the router doesn't need changes.
