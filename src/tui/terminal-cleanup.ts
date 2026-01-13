/**
 * Shared terminal cleanup utilities
 *
 * Provides a consistent cleanup function for all terminal-kit based screens
 * to properly restore terminal state on exit.
 */

import termKit from 'terminal-kit';

const term = termKit.terminal;

/**
 * Fully reset the terminal to a clean state.
 *
 * This should be called when exiting any fullscreen terminal-kit application
 * to ensure the terminal is left in a usable state. Handles:
 * - Clearing the screen
 * - Releasing input grabbing
 * - Exiting fullscreen/alternate screen buffer
 * - Resetting styles
 * - Resetting raw mode
 * - Showing cursor
 */
export function cleanupTerminal(): void {
  // Clear the alternate screen buffer before exiting
  term.clear();

  // Release input grabbing
  term.grabInput(false);

  // Exit fullscreen (alternate screen buffer)
  term.fullscreen(false);

  // Reset terminal styles
  term.styleReset();

  // Explicitly reset raw mode if it was set
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(false);
  }

  // Explicitly show cursor and clear screen using ANSI codes
  // This ensures the terminal is fully reset even if terminal-kit methods didn't complete
  process.stdout.write('\x1b[?25h');  // Show cursor
  process.stdout.write('\x1b[2J');    // Clear entire screen
  process.stdout.write('\x1b[H');     // Move cursor to home position
}
