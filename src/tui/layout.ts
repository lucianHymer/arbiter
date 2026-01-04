// TUI layout configuration using blessed
// Defines the screen layout, panels, and UI structure

import blessed from 'blessed';

/**
 * Layout elements interface - exposes all UI components
 */
export interface LayoutElements {
  screen: blessed.Widgets.Screen;
  titleBox: blessed.Widgets.BoxElement;
  conversationBox: blessed.Widgets.BoxElement;
  statusBox: blessed.Widgets.BoxElement;
  inputBox: blessed.Widgets.TextboxElement;
}

/**
 * Box drawing characters for roguelike aesthetic
 */
const BOX_CHARS = {
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
 * Creates the blessed screen layout matching the architecture doc design
 *
 * Layout:
 * - Full terminal takeover
 * - Title area at top with "THE ARBITER" and subtitle
 * - Main conversation area (scrollable)
 * - Status bar showing Arbiter context %, Orchestrator context %, current tool
 * - Input box at bottom with ">" prompt
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

  // Title box at the top
  const titleBox = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 4,
    content: '',
    tags: true,
    style: {
      fg: 'white',
      bg: 'black',
    },
  });

  // Set title content with box drawing characters
  updateTitleContent(titleBox, screen.width as number);

  // Main conversation area (scrollable)
  const conversationBox = blessed.box({
    parent: screen,
    top: 4,
    left: 0,
    width: '100%',
    height: '100%-10', // Leave room for status (3 lines) and input (3 lines)
    content: '',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: '\u2588', // █
      style: {
        fg: 'white',
      },
    },
    mouse: true,
    keys: true,
    vi: true,
    style: {
      fg: 'white',
      bg: 'black',
      border: {
        fg: 'white',
      },
    },
    border: {
      type: 'line',
    },
  });

  // Override border characters to use double-line box drawing
  conversationBox.border = {
    type: 'line',
    ch: ' ',
    top: BOX_CHARS.horizontal,
    bottom: BOX_CHARS.horizontal,
    left: BOX_CHARS.vertical,
    right: BOX_CHARS.vertical,
  } as blessed.Widgets.Border;

  // Status bar area (3 lines)
  const statusBox = blessed.box({
    parent: screen,
    bottom: 3,
    left: 0,
    width: '100%',
    height: 4,
    content: '',
    tags: true,
    style: {
      fg: 'white',
      bg: 'black',
    },
  });

  // Input box at the bottom
  const inputBox = blessed.textbox({
    parent: screen,
    bottom: 0,
    left: 2,  // Leave room for "> " prompt
    width: '100%-2',
    height: 3,
    inputOnFocus: true,
    mouse: true,
    keys: true,
    style: {
      fg: 'white',
      bg: 'black',
      border: {
        fg: 'white',
      },
    },
    border: {
      type: 'line',
    },
  });

  // Create a fixed prompt label "> " that sits to the left of the input
  const promptLabel = blessed.text({
    parent: screen,
    bottom: 1,
    left: 0,
    width: 2,
    height: 1,
    content: '> ',
    style: {
      fg: 'white',
      bg: 'black',
    },
  });

  // Handle screen resize to update title width
  screen.on('resize', () => {
    updateTitleContent(titleBox, screen.width as number);
    screen.render();
  });

  // Set up quit key bindings
  screen.key(['escape', 'q', 'C-c'], () => {
    return process.exit(0);
  });

  return {
    screen,
    titleBox,
    conversationBox,
    statusBox,
    inputBox,
  };
}

/**
 * Updates the title box content with proper width-based formatting
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

  const titleLine = BOX_CHARS.vertical +
    ' '.repeat(titlePadding) +
    `{bold}${title}{/bold}` +
    ' '.repeat(effectiveWidth - titlePadding - title.length) +
    BOX_CHARS.vertical;

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
