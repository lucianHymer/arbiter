/**
 * Debug Log Viewer Module
 *
 * Provides a simple built-in log viewer for the TUI, avoiding signal handling
 * issues with external tools like `less`.
 */

import * as fs from 'node:fs';
import { DEBUG_LOG_PATH } from './constants.js';

/**
 * Dependencies required by the log viewer
 */
export interface LogViewerDeps {
  /** terminal-kit terminal instance */
  term: any;
  /** Get current terminal width */
  getWidth: () => number;
  /** Get current terminal height */
  getHeight: () => number;
  /** Callback when viewer closes normally */
  onClose: () => void;
  /** Callback when viewer closes and should show exit prompt */
  onCloseAndExit: () => void;
  /** Callback when viewer closes and should suspend */
  onCloseAndSuspend: () => void;
}

/**
 * Log viewer instance returned by createLogViewer
 */
export interface LogViewer {
  /** Open the log viewer */
  open: () => void;
  /** Check if the log viewer is currently open */
  isOpen: () => boolean;
}

/**
 * Creates a log viewer instance
 */
export function createLogViewer(deps: LogViewerDeps): LogViewer {
  let isViewerOpen = false;
  let logLines: string[] = [];
  let logScrollOffset = 0;
  let keyHandler: ((key: string) => void) | null = null;

  /**
   * Draw the log viewer UI
   */
  function draw(): void {
    const { term, getWidth, getHeight } = deps;
    const width = getWidth();
    const height = getHeight();

    term.clear();
    const visibleLines = height - 2; // Leave room for header and footer

    // Header - green like INSERT mode
    term.moveTo(1, 1);
    process.stdout.write('\x1b[42;30m DEBUG LOG \x1b[0m');
    process.stdout.write(
      `\x1b[2m (${logLines.length} lines, showing ${logScrollOffset + 1}-${Math.min(logScrollOffset + visibleLines, logLines.length)})\x1b[0m`,
    );

    // Log content
    for (let i = 0; i < visibleLines; i++) {
      const lineIdx = logScrollOffset + i;
      term.moveTo(1, i + 2);
      term.eraseLine();
      if (lineIdx < logLines.length) {
        // Truncate long lines and display with default colors
        const line = logLines[lineIdx].substring(0, width - 1);
        process.stdout.write(`\x1b[0m${line}`);
      }
    }

    // Footer - green like INSERT mode
    term.moveTo(1, height);
    process.stdout.write(
      '\x1b[42;30m j/k:line  u/d:half  b/f:page  g/G:top/bottom  q:close  ^C:quit  ^Z:suspend \x1b[0m',
    );
  }

  /**
   * Handle a key press in the log viewer
   */
  function handleKey(key: string): void {
    const { getHeight, onClose, onCloseAndExit, onCloseAndSuspend } = deps;
    const height = getHeight();
    const visibleLines = height - 2;
    const halfPage = Math.floor(visibleLines / 2);
    const maxScroll = Math.max(0, logLines.length - visibleLines);

    if (key === 'q' || key === 'ESCAPE') {
      // Close log viewer
      close();
      onClose();
      return;
    }

    if (key === 'CTRL_C') {
      // Close log viewer and show exit prompt
      close();
      onCloseAndExit();
      return;
    }

    if (key === 'CTRL_Z') {
      // Close log viewer and suspend
      close();
      onCloseAndSuspend();
      return;
    }
    // Note: CTRL_BACKSLASH is handled via raw stdin listener in start()

    if (key === 'j' || key === 'DOWN') {
      logScrollOffset = Math.min(maxScroll, logScrollOffset + 1);
      draw();
    } else if (key === 'k' || key === 'UP') {
      logScrollOffset = Math.max(0, logScrollOffset - 1);
      draw();
    } else if (key === 'g') {
      logScrollOffset = 0;
      draw();
    } else if (key === 'G') {
      logScrollOffset = maxScroll;
      draw();
    } else if (key === 'u') {
      // Half page up
      logScrollOffset = Math.max(0, logScrollOffset - halfPage);
      draw();
    } else if (key === 'd') {
      // Half page down
      logScrollOffset = Math.min(maxScroll, logScrollOffset + halfPage);
      draw();
    } else if (key === 'b' || key === 'PAGE_UP') {
      // Full page up
      logScrollOffset = Math.max(0, logScrollOffset - visibleLines);
      draw();
    } else if (key === 'f' || key === 'PAGE_DOWN') {
      // Full page down
      logScrollOffset = Math.min(maxScroll, logScrollOffset + visibleLines);
      draw();
    }
  }

  /**
   * Open the log viewer
   */
  function open(): void {
    const { term, getHeight } = deps;

    // Check if log file exists
    if (!fs.existsSync(DEBUG_LOG_PATH)) {
      return;
    }

    // Read the log file
    let logContent: string;
    try {
      logContent = fs.readFileSync(DEBUG_LOG_PATH, 'utf-8');
    } catch (_err) {
      return;
    }

    isViewerOpen = true;
    logLines = logContent.split('\n');
    logScrollOffset = Math.max(0, logLines.length - (getHeight() - 2)); // Start at bottom

    draw();

    // Set up key handler
    keyHandler = (key: string) => handleKey(key);
    term.on('key', keyHandler);
  }

  /**
   * Close the log viewer (internal cleanup)
   */
  function close(): void {
    const { term } = deps;

    if (keyHandler) {
      term.off('key', keyHandler);
      keyHandler = null;
    }
    isViewerOpen = false;
  }

  /**
   * Check if the log viewer is currently open
   */
  function isOpen(): boolean {
    return isViewerOpen;
  }

  return {
    open,
    isOpen,
  };
}
