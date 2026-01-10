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

## Related Files

- src/tui/tui-termkit.ts
