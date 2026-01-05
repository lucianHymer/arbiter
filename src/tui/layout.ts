// TUI layout configuration using blessed
// RPG-style terminal interface with wizard council theme

import blessed from 'blessed';

/**
 * Layout elements interface - exposes all UI components
 * Extended to include logbook overlay for raw log view
 */
export interface LayoutElements {
  screen: blessed.Widgets.Screen;
  titleBox: blessed.Widgets.BoxElement;
  chatLog: blessed.Widgets.Log;  // AIM-style scrollable chat log
  statusBox: blessed.Widgets.BoxElement;
  inputBox: blessed.Widgets.TextareaElement;
  // Logbook overlay (toggled with Ctrl+O)
  logbookOverlay?: blessed.Widgets.BoxElement;
  logbookContent?: blessed.Widgets.Log;
}

/**
 * Position and dimensions for the tile rendering area (right 2/3 of screen)
 * Used for direct process.stdout.write() tile rendering
 */
export interface TileAreaPosition {
  x: number;      // Column where tile area starts (1-based for ANSI)
  y: number;      // Row where tile area starts (1-based for ANSI)
  width: number;  // Width in characters
  height: number; // Height in rows
}

/**
 * Gets the position and dimensions of the tile rendering area
 * The tile area occupies the right 2/3 of the screen, below the title
 *
 * @param screen - The blessed screen to calculate position from
 * @returns TileAreaPosition with x, y, width, height for direct stdout rendering
 */
export function getTileAreaPosition(screen: blessed.Widgets.Screen): TileAreaPosition {
  const screenWidth = screen.width as number;
  const screenHeight = screen.height as number;

  // Tile area starts at 1/3 of screen width (after the chat panel)
  const x = Math.floor(screenWidth / 3) + 1; // +1 for 1-based ANSI positioning

  // Tile area starts below the title (row 4, which is after 4-line title)
  const y = 5; // 1-based, so row 5 is after 4-line title

  // Width is remaining 2/3 of screen
  const width = screenWidth - Math.floor(screenWidth / 3);

  // Height is screen height minus title (4) and status/input (7)
  const height = screenHeight - 11;

  return { x, y, width, height };
}

/**
 * Box drawing characters for roguelike aesthetic
 * Double-line characters for main borders
 */
const BOX_CHARS = {
  // Double-line characters
  topLeft: '\u2554',     // ╔
  topRight: '\u2557',    // ╗
  bottomLeft: '\u255A',  // ╚
  bottomRight: '\u255D', // ╝
  horizontal: '\u2550',  // ═
  vertical: '\u2551',    // ║
  leftT: '\u2560',       // ╠
  rightT: '\u2563',      // ╣
};

/**
 * Color constants for the RPG theme
 * Brown borders where possible, gold title
 */
const COLORS = {
  brown: '#8B4513',      // Wood-like brown for borders
  gold: 'yellow',        // Gold/yellow for title
  white: 'white',        // Default text
  gray: 'gray',          // Hints and secondary text
};

/**
 * Creates the blessed screen layout with RPG-style wizard council theme
 *
 * Layout:
 * - Title Box (4 lines): "THE ARBITER" + subtitle with double-line borders
 * - Stage Box (main area): Where sprites, campfire, speech bubbles render
 * - Status Bar (3-4 lines): Context percentages, tool indicator, logbook hint
 * - Input Box (3 lines): Text input with "> " prompt
 * - Logbook Overlay (hidden): Full-screen raw log view, toggled with Tab
 */
export function createLayout(): LayoutElements {
  // Create the main screen
  const screen = blessed.screen({
    smartCSR: true,
    title: 'THE ARBITER',
    fullUnicode: true,
    dockBorders: true,
    autoPadding: false,
  });

  // Title box at the top (4 lines) - left 1/3 of screen
  const titleBox = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '33%',
    height: 4,
    content: '',
    tags: true,
    style: {
      fg: COLORS.white,
      bg: 'black',
    },
  });

  // Set initial title content (using titleBox width = 33% of screen)
  updateTitleContent(titleBox, Math.floor((screen.width as number) / 3));

  // AIM-style chat log - scrollable message history
  const chatLog = blessed.log({
    parent: screen,
    top: 4,  // Below title
    left: 0,
    width: '33%',
    height: '100%-13',  // Leave room for title (4) + status (4) + input (5)
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: '\u2502',  // │
      style: { fg: 'cyan' }
    },
    mouse: true,
    keys: true,
    vi: false,
    tags: true,  // For color formatting
    style: {
      fg: 'white',
      bg: 'black',
    },
    border: {
      type: 'line',
    },
    label: ' Chat ',
  });

  // Status bar area (4 lines above input) - left 1/3 of screen
  const statusBox = blessed.box({
    parent: screen,
    bottom: 5,  // Above the 5-line input box
    left: 0,
    width: '33%',
    height: 4,
    content: '',
    tags: true,
    style: {
      fg: COLORS.white,
      bg: 'black',
    },
  });

  // Input box at the bottom (5 lines) - left 1/3 of screen
  // Taller for multi-line input and better paste support
  const inputBox = blessed.textarea({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '33%',
    height: 5,
    inputOnFocus: true,
    mouse: true,
    keys: true,
    vi: false,  // Disable vi mode for normal editing
    scrollable: true,  // Allow scrolling if content is long
    alwaysScroll: true,
    tags: false,  // Don't interpret tags in input
    style: {
      fg: COLORS.white,
      bg: 'black',
    },
    border: {
      type: 'line',
    },
    label: ' > ',
  });

  // Create logbook overlay (hidden by default)
  const { logbookOverlay, logbookContent } = createLogbookOverlay(screen);

  // Handle screen resize to update title width
  screen.on('resize', () => {
    const chatWidth = Math.floor((screen.width as number) / 3);
    updateTitleContent(titleBox, chatWidth);
    screen.render();
  });

  // Set up quit key bindings on screen level
  screen.key(['C-c', 'C-z'], () => {
    screen.destroy();
    process.exit(0);
  });

  // Also bind quit keys on the input box since it captures focus
  inputBox.key(['C-c', 'C-z'], () => {
    screen.destroy();
    process.exit(0);
  });

  // Set up Ctrl+O key binding to toggle logbook overlay
  // Using Ctrl+O instead of Tab to avoid focus loop issues with blessed textboxes
  const toggleLogbook = () => {
    if (logbookOverlay.hidden) {
      logbookOverlay.show();
      logbookOverlay.focus();
    } else {
      logbookOverlay.hide();
      inputBox.focus();
    }
    screen.render();
  };

  // Bind Ctrl+O on screen level for when other elements are focused
  screen.key(['C-o'], toggleLogbook);

  // Bind Ctrl+O on inputBox as well
  inputBox.key(['C-o'], toggleLogbook);

  // When logbook is open, Ctrl+O and Escape close it
  logbookOverlay.key(['C-o', 'escape'], () => {
    logbookOverlay.hide();
    inputBox.focus();
    screen.render();
  });

  // Quit keys on logbook overlay
  logbookOverlay.key(['C-c', 'C-z'], () => {
    screen.destroy();
    process.exit(0);
  });

  return {
    screen,
    titleBox,
    chatLog,
    statusBox,
    inputBox,
    logbookOverlay,
    logbookContent,
  };
}

/**
 * Creates the logbook overlay - a full-screen scrollable log view
 * Hidden by default, toggled with Tab key
 */
function createLogbookOverlay(screen: blessed.Widgets.Screen): {
  logbookOverlay: blessed.Widgets.BoxElement;
  logbookContent: blessed.Widgets.Log;
} {
  // Container box for the logbook overlay
  const logbookOverlay = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    hidden: true,
    tags: true,
    style: {
      fg: COLORS.white,
      bg: 'black',
    },
  });

  // Title bar for logbook
  const logbookTitle = blessed.box({
    parent: logbookOverlay,
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: '',
    tags: true,
    style: {
      fg: COLORS.white,
      bg: 'black',
    },
  });

  // Set logbook title content
  const updateLogbookTitle = () => {
    const width = Math.max((screen.width as number) - 2, 78);
    const title = 'LOGBOOK';
    const hint = '[Ctrl+O] Close';

    const topBorder = BOX_CHARS.topLeft + BOX_CHARS.horizontal.repeat(width) + BOX_CHARS.topRight;

    const titlePadding = Math.max(0, Math.floor((width - title.length) / 2));
    const hintStart = width - hint.length - 2;

    let titleLine = BOX_CHARS.vertical + ' '.repeat(titlePadding) + `{bold}${title}{/bold}`;
    const currentLen = titlePadding + title.length;
    const spacesToHint = hintStart - currentLen;
    titleLine += ' '.repeat(Math.max(0, spacesToHint)) + `{gray-fg}${hint}{/gray-fg}`;
    const remainingSpace = width - (titlePadding + title.length + Math.max(0, spacesToHint) + hint.length);
    titleLine += ' '.repeat(Math.max(0, remainingSpace)) + BOX_CHARS.vertical;

    const separator = BOX_CHARS.leftT + BOX_CHARS.horizontal.repeat(width) + BOX_CHARS.rightT;

    logbookTitle.setContent(topBorder + '\n' + titleLine + '\n' + separator);
  };
  updateLogbookTitle();

  // Scrollable log content
  const logbookContent = blessed.log({
    parent: logbookOverlay,
    top: 3,
    left: 1,
    width: '100%-2',
    height: '100%-4',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: '\u2588', // █
      style: {
        fg: COLORS.white,
      },
    },
    mouse: true,
    keys: true,
    vi: true,
    style: {
      fg: COLORS.white,
      bg: 'black',
    },
  });

  // Bottom border
  const logbookBottom = blessed.box({
    parent: logbookOverlay,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: '',
    tags: true,
    style: {
      fg: COLORS.white,
      bg: 'black',
    },
  });

  const updateLogbookBottom = () => {
    const width = Math.max((screen.width as number) - 2, 78);
    logbookBottom.setContent(BOX_CHARS.bottomLeft + BOX_CHARS.horizontal.repeat(width) + BOX_CHARS.bottomRight);
  };
  updateLogbookBottom();

  // Handle resize for logbook
  screen.on('resize', () => {
    updateLogbookTitle();
    updateLogbookBottom();
  });

  return { logbookOverlay, logbookContent };
}

/**
 * Updates the title box content with proper width-based formatting
 * Creates the RPG-style header with "THE ARBITER" and subtitle
 */
function updateTitleContent(titleBox: blessed.Widgets.BoxElement, width: number): void {
  const title = 'THE ARBITER';
  const subtitle = 'OF THAT WHICH WAS, THAT WHICH IS, AND THAT WHICH SHALL COME TO BE';

  // Calculate effective width (accounting for border characters)
  const effectiveWidth = Math.max(width - 2, 80);

  // Create top border
  const topBorder = BOX_CHARS.topLeft + BOX_CHARS.horizontal.repeat(effectiveWidth) + BOX_CHARS.topRight;

  // Center the title and subtitle
  const titlePadding = Math.max(0, Math.floor((effectiveWidth - title.length) / 2));
  const subtitlePadding = Math.max(0, Math.floor((effectiveWidth - subtitle.length) / 2));

  // Title line with gold/yellow color and bold
  const titleLine = BOX_CHARS.vertical +
    ' '.repeat(titlePadding) +
    `{bold}{yellow-fg}${title}{/yellow-fg}{/bold}` +
    ' '.repeat(effectiveWidth - titlePadding - title.length) +
    BOX_CHARS.vertical;

  // Subtitle line
  const subtitleLine = BOX_CHARS.vertical +
    ' '.repeat(subtitlePadding) +
    subtitle +
    ' '.repeat(Math.max(0, effectiveWidth - subtitlePadding - subtitle.length)) +
    BOX_CHARS.vertical;

  // Create separator
  const separator = BOX_CHARS.leftT + BOX_CHARS.horizontal.repeat(effectiveWidth) + BOX_CHARS.rightT;

  titleBox.setContent(
    topBorder + '\n' +
    titleLine + '\n' +
    subtitleLine + '\n' +
    separator
  );
}


/**
 * Creates the input prompt line with box drawing characters
 */
export function createInputPrompt(width: number): string {
  const effectiveWidth = Math.max(width - 4, 76);
  const promptLine = BOX_CHARS.vertical + ' > ';
  const endLine = ' '.repeat(effectiveWidth) + BOX_CHARS.vertical;
  const bottomBorder = BOX_CHARS.bottomLeft + BOX_CHARS.horizontal.repeat(width - 2) + BOX_CHARS.bottomRight;

  return promptLine + endLine + '\n' + bottomBorder;
}

/**
 * Creates a horizontal separator line
 */
export function createSeparator(width: number): string {
  const effectiveWidth = Math.max(width - 2, 78);
  return BOX_CHARS.leftT + BOX_CHARS.horizontal.repeat(effectiveWidth) + BOX_CHARS.rightT;
}

/**
 * Adds a log entry to the logbook
 * Call this to append timestamped entries to the raw log view
 */
export function appendToLogbook(elements: LayoutElements, entry: string): void {
  if (elements.logbookContent) {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    elements.logbookContent.log(`[${timestamp}] ${entry}`);
  }
}
