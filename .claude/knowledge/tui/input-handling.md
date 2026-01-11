# Terminal-Kit TUI Input Handling System

The TUI uses terminal-kit with a two-mode input system inspired by vim.

## Input Modes

### INSERT Mode
- Character entry directly to input buffer
- BACKSPACE removes last character
- ENTER submits input via `inputCallback`
- ESC switches to NORMAL mode

### NORMAL Mode
- `i` or `ENTER` switches to INSERT mode
- `j`/`k` for scrolling chat log
- `g`/`G` for scroll to top/bottom
- `o` opens log viewer overlay

## State Management

Input state stored in TUIState:
- `inputBuffer: string` - Current input text
- `mode: 'INSERT' | 'NORMAL'` - Current input mode

## Layout

- Input line at bottom of screen
- Width: ~40-180 characters depending on terminal
- Cursor position calculated from `inputBuffer.length`
- Cursor rendered as white block in INSERT mode

## Input Submission Flow

1. User presses ENTER in INSERT mode
2. `inputCallback` triggered (registered via `onInput()`)
3. Input forwarded to router
4. Buffer cleared after submission

## Rendering

The `drawInput()` function (~lines 568-595):
- Draws mode indicator and prompt
- Renders input buffer text
- Shows cursor at end of buffer (INSERT mode only)
- No explicit cursor position tracking needed

## Terminal Signal Handling

In raw mode, the OS doesn't generate signals from control characters - they arrive as bytes. Must handle them manually and send signals with `process.kill()`.

### Control Key Handling (Main TUI)

| Key | Event | Action |
|-----|-------|--------|
| Ctrl-C | `CTRL_C` key event | Shows exit confirmation prompt |
| Ctrl-Z | `CTRL_Z` key event | Suspends process via `process.kill(process.pid, 'SIGTSTP')` |
| Ctrl-\ | Raw stdin byte `0x1c` | Passes through for dtach via `process.kill(process.pid, 'SIGQUIT')` |

### Ctrl-Z Suspend Implementation

```typescript
// Exit raw mode
process.stdin.setRawMode(false);
// Remove any listeners that might interfere
process.removeAllListeners('SIGTSTP');
// Send signal to process group
process.kill(0, 'SIGTSTP');
```

### SIGCONT Resume Handler

```typescript
process.on('SIGCONT', () => {
  // Toggle raw mode off/on to reset termios (OS resets terminal attrs on suspend)
  process.stdin.setRawMode(false);
  process.stdin.setRawMode(true);
  // Re-init terminal-kit
  term.grabInput(true);
  term.fullscreen(true);
  // Redraw
  fullDraw();
});
```

### Ctrl-\ for dtach

terminal-kit doesn't emit `CTRL_BACKSLASH` as a key event. Must use raw stdin data handler:

```typescript
process.stdin.on('data', (data) => {
  if (data.includes(0x1c)) {
    process.kill(process.pid, 'SIGQUIT');
  }
});
```

### dtach Reattach

Use `dtach -r winch` flag to force SIGWINCH on reattach. SIGWINCH handler toggles raw mode and calls `fullDraw()`.

### Intro Screens

TitleScreen, CharacterSelect, ForestIntro, and GitignoreCheck screens:
- Exit on Ctrl-C/Z
- Pass through Ctrl-\ for dtach

## Related Files

- src/tui/tui-termkit.ts
- src/tui/screens/TitleScreen-termkit.ts
- src/tui/screens/CharacterSelect-termkit.ts
- src/tui/screens/ForestIntro-termkit.ts
- src/tui/screens/GitignoreCheck-termkit.ts
