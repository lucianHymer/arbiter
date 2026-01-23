/**
 * Quest Log Overlay Module
 *
 * Displays a floating RPG-style quest tracker in the bottom-left corner of the tile scene.
 * Shows tasks from the shared task list with status indicators and owners.
 */

import type { Terminal } from 'terminal-kit';
import type { Task, TaskWatcher } from './taskWatcher.js';
import { CHAR_HEIGHT, extractTile, RESET, type RGB, renderTile, type Tileset } from './tileset.js';

// ============================================================================
// Types
// ============================================================================

export interface QuestLogDeps {
  term: Terminal;
  getTileset: () => Tileset | null;
  getLayout: () => LayoutInfo;
  taskWatcher: TaskWatcher;
}

export interface LayoutInfo {
  tileArea: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface QuestLog {
  /** Draw the quest log overlay */
  draw: () => void;
  /** Toggle visibility */
  toggle: () => void;
  /** Check if visible */
  isVisible: () => boolean;
  /** Show the quest log */
  show: () => void;
  /** Hide the quest log */
  hide: () => void;
  /** Handle key events (returns true if handled) */
  handleKey: (key: string) => boolean;
}

// ============================================================================
// Constants
// ============================================================================

// Dialogue box tile indices (for panel borders)
const DIALOGUE_TILES = {
  TOP_LEFT: 38,
  TOP_RIGHT: 39,
  BOTTOM_LEFT: 48,
  BOTTOM_RIGHT: 49,
};

// Status indicators
const STATUS_ICONS = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
};

// Colors for status
const STATUS_COLORS = {
  pending: '\x1b[90m', // dim gray
  in_progress: '\x1b[93m', // yellow
  completed: '\x1b[92m', // green
};

// Max tasks to show (to fit in panel)
const MAX_VISIBLE_TASKS = 8;

// Panel dimensions (in tiles)
const PANEL_WIDTH_TILES = 4;

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a quest log overlay instance
 */
export function createQuestLog(deps: QuestLogDeps): QuestLog {
  const { term, getTileset, getLayout, taskWatcher } = deps;

  // Internal state
  let visible = false;
  let scrollOffset = 0;

  // ============================================================================
  // Helper Functions
  // ============================================================================

  /**
   * Strip ANSI escape codes from a string
   */
  function stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }

  /**
   * Create middle fill row for dialogue box (samples from left tile's middle column)
   */
  function createMiddleFill(leftTile: RGB[][], charRow: number): string {
    const pixelRowTop = charRow * 2;
    const pixelRowBot = pixelRowTop + 1;
    const sampleX = 8; // Middle column

    let result = '';
    for (let x = 0; x < 16; x++) {
      const topPixel = leftTile[pixelRowTop][sampleX];
      const botPixel = leftTile[pixelRowBot]?.[sampleX] || topPixel;
      result += `\x1b[48;2;${topPixel.r};${topPixel.g};${topPixel.b}m`;
      result += `\x1b[38;2;${botPixel.r};${botPixel.g};${botPixel.b}m`;
      result += '\u2584';
    }
    result += RESET;
    return result;
  }

  /**
   * Wrap text with consistent background color
   */
  function wrapTextWithBg(text: string, bgColor: string): string {
    const bgMaintained = text.replace(/\x1b\[0m/g, `\x1b[0m${bgColor}`);
    return bgColor + bgMaintained + RESET;
  }

  /**
   * Create middle row border segments for panels taller than 2 tiles
   */
  function createMiddleRowBorders(
    tileset: Tileset,
    charRow: number,
  ): { left: string; fill: string; right: string } {
    const topLeftTile = extractTile(tileset, DIALOGUE_TILES.TOP_LEFT);
    const topRightTile = extractTile(tileset, DIALOGUE_TILES.TOP_RIGHT);

    const actualCharRow = charRow % 4;
    const pixelRowTop = 8 + actualCharRow * 2;
    const pixelRowBot = pixelRowTop + 1;

    let left = '';
    for (let x = 0; x < 16; x++) {
      const topPixel = topLeftTile[pixelRowTop][x];
      const botPixel = topLeftTile[pixelRowBot]?.[x] || topPixel;
      left += `\x1b[48;2;${topPixel.r};${topPixel.g};${topPixel.b}m`;
      left += `\x1b[38;2;${botPixel.r};${botPixel.g};${botPixel.b}m`;
      left += '\u2584';
    }
    left += RESET;

    let right = '';
    for (let x = 0; x < 16; x++) {
      const topPixel = topRightTile[pixelRowTop][x];
      const botPixel = topRightTile[pixelRowBot]?.[x] || topPixel;
      right += `\x1b[48;2;${topPixel.r};${topPixel.g};${topPixel.b}m`;
      right += `\x1b[38;2;${botPixel.r};${botPixel.g};${botPixel.b}m`;
      right += '\u2584';
    }
    right += RESET;

    const sampleX = 8;
    const topPixel = topLeftTile[pixelRowTop][sampleX];
    const botPixel = topLeftTile[pixelRowBot]?.[sampleX] || topPixel;
    let fill = '';
    for (let x = 0; x < 16; x++) {
      fill += `\x1b[48;2;${topPixel.r};${topPixel.g};${topPixel.b}m`;
      fill += `\x1b[38;2;${botPixel.r};${botPixel.g};${botPixel.b}m`;
      fill += '\u2584';
    }
    fill += RESET;

    return { left, fill, right };
  }

  /**
   * Render a compact tile-bordered message panel
   */
  function renderPanel(
    tileset: Tileset,
    textLines: string[],
    widthTiles: number,
    heightTiles: number,
  ): string[] {
    const topLeft = extractTile(tileset, DIALOGUE_TILES.TOP_LEFT);
    const topRight = extractTile(tileset, DIALOGUE_TILES.TOP_RIGHT);
    const bottomLeft = extractTile(tileset, DIALOGUE_TILES.BOTTOM_LEFT);
    const bottomRight = extractTile(tileset, DIALOGUE_TILES.BOTTOM_RIGHT);

    const tlRendered = renderTile(topLeft);
    const trRendered = renderTile(topRight);
    const blRendered = renderTile(bottomLeft);
    const brRendered = renderTile(bottomRight);

    const middleTopRendered: string[] = [];
    const middleBottomRendered: string[] = [];
    for (let row = 0; row < CHAR_HEIGHT; row++) {
      middleTopRendered.push(createMiddleFill(topLeft, row));
      middleBottomRendered.push(createMiddleFill(bottomLeft, row));
    }

    const middleRowBorders: { left: string; fill: string; right: string }[] = [];
    for (let row = 0; row < CHAR_HEIGHT; row++) {
      middleRowBorders.push(createMiddleRowBorders(tileset, row));
    }

    const middleTiles = Math.max(0, widthTiles - 2);
    const interiorWidth = middleTiles * 16;
    const middleRows = Math.max(0, heightTiles - 2);

    const bgSamplePixel = topLeft[8][8];
    const textBgColor = `\x1b[48;2;${bgSamplePixel.r};${bgSamplePixel.g};${bgSamplePixel.b}m`;

    const boxLines: string[] = [];

    // Top row of tiles
    for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
      let line = tlRendered[charRow];
      for (let m = 0; m < middleTiles; m++) {
        line += middleTopRendered[charRow];
      }
      line += trRendered[charRow];
      boxLines.push(line);
    }

    // Middle rows of tiles (for height > 2)
    for (let middleRowIdx = 0; middleRowIdx < middleRows; middleRowIdx++) {
      for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
        const borders = middleRowBorders[charRow];
        let line = borders.left;
        for (let m = 0; m < middleTiles; m++) {
          line += borders.fill;
        }
        line += borders.right;
        boxLines.push(line);
      }
    }

    // Bottom row of tiles
    for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
      let line = blRendered[charRow];
      for (let m = 0; m < middleTiles; m++) {
        line += middleBottomRendered[charRow];
      }
      line += brRendered[charRow];
      boxLines.push(line);
    }

    // Place text lines in the interior
    const boxHeight = CHAR_HEIGHT * heightTiles;
    const interiorStartRow = 2;
    const interiorEndRow = boxHeight - 3;

    // Start from top of interior area (not centered, since we want scrollable list)
    for (let i = 0; i < textLines.length; i++) {
      const boxLineIndex = interiorStartRow + i;
      if (boxLineIndex <= interiorEndRow && boxLineIndex < boxLines.length) {
        let line = textLines[i];
        let visibleLength = stripAnsi(line).length;

        // Truncate if too long
        if (visibleLength > interiorWidth - 2) {
          let truncated = '';
          let truncatedVisible = 0;
          const maxLen = interiorWidth - 5;
          for (let c = 0; c < line.length && truncatedVisible < maxLen; c++) {
            truncated += line[c];
            truncatedVisible = stripAnsi(truncated).length;
          }
          line = `${truncated}...`;
          visibleLength = stripAnsi(line).length;
        }

        // Left-align with small padding
        const padding = 1;
        const rightPadding = Math.max(0, interiorWidth - padding - visibleLength);
        const textContent = ' '.repeat(padding) + line + ' '.repeat(rightPadding);
        const textWithBg = wrapTextWithBg(textContent, textBgColor);

        const tileRowIdx = Math.floor(boxLineIndex / CHAR_HEIGHT);
        const charRow = boxLineIndex % CHAR_HEIGHT;

        let leftBorder: string;
        let rightBorder: string;
        if (tileRowIdx === 0) {
          leftBorder = tlRendered[charRow];
          rightBorder = trRendered[charRow];
        } else if (tileRowIdx === heightTiles - 1) {
          leftBorder = blRendered[charRow];
          rightBorder = brRendered[charRow];
        } else {
          const borders = middleRowBorders[charRow];
          leftBorder = borders.left;
          rightBorder = borders.right;
        }

        boxLines[boxLineIndex] = leftBorder + textWithBg + rightBorder;
      }
    }

    return boxLines;
  }

  /**
   * Format a task for display
   */
  function formatTask(task: Task, maxWidth: number): string {
    const icon = STATUS_ICONS[task.status] || '?';
    const color = STATUS_COLORS[task.status] || '';

    // Format owner (abbreviate orchestrator names)
    let ownerTag = '';
    if (task.owner) {
      // Extract orchestrator number if it matches pattern
      const orchMatch = task.owner.match(/[Oo]rchestrator\s*(\S+)/i);
      if (orchMatch) {
        ownerTag = ` \x1b[36m[${orchMatch[1]}]\x1b[0m`;
      } else if (task.owner.toLowerCase().includes('arbiter')) {
        ownerTag = ' \x1b[33m[A]\x1b[0m';
      } else {
        ownerTag = ` \x1b[90m[${task.owner.substring(0, 3)}]\x1b[0m`;
      }
    }

    // Truncate subject if needed
    const ownerLen = task.owner ? 5 : 0;
    const maxSubjectLen = maxWidth - 4 - ownerLen; // icon + space + owner
    let subject = task.subject;
    if (subject.length > maxSubjectLen) {
      subject = `${subject.substring(0, maxSubjectLen - 2)}..`;
    }

    return `${color}${icon}\x1b[0m ${subject}${ownerTag}`;
  }

  // ============================================================================
  // Drawing
  // ============================================================================

  /**
   * Draw the quest log overlay
   */
  function draw(): void {
    if (!visible) return;

    const tileset = getTileset();
    if (!tileset) return;

    const tasks = taskWatcher.getTasks();
    const layout = getLayout();

    // Build text lines for the panel
    const textLines: string[] = [];

    // Header
    textLines.push('\x1b[97;1mQuests\x1b[0m');
    textLines.push(''); // Separator

    if (tasks.length === 0) {
      textLines.push('\x1b[90m(no active quests)\x1b[0m');
    } else {
      // Show tasks with scroll offset
      const visibleTasks = tasks.slice(scrollOffset, scrollOffset + MAX_VISIBLE_TASKS);
      const interiorWidth = (PANEL_WIDTH_TILES - 2) * 16;

      for (const task of visibleTasks) {
        textLines.push(formatTask(task, interiorWidth - 2));
      }

      // Show scroll indicator if there are more tasks
      if (tasks.length > MAX_VISIBLE_TASKS) {
        const moreCount = tasks.length - scrollOffset - MAX_VISIBLE_TASKS;
        if (moreCount > 0) {
          textLines.push(`\x1b[90m  +${moreCount} more...\x1b[0m`);
        }
      }
    }

    // Calculate panel height based on content (minimum 2 tiles)
    const contentRows = textLines.length + 2; // +2 for top/bottom border interior
    const heightTiles = Math.max(2, Math.ceil(contentRows / CHAR_HEIGHT) + 1);

    // Render the panel
    const panelLines = renderPanel(tileset, textLines, PANEL_WIDTH_TILES, heightTiles);

    // Position in bottom-left corner of the scene
    const panelX = layout.tileArea.x;
    const panelY = layout.tileArea.y + layout.tileArea.height - panelLines.length;

    // Draw panel
    for (let i = 0; i < panelLines.length; i++) {
      term.moveTo(panelX, panelY + i);
      process.stdout.write(panelLines[i] + RESET);
    }
  }

  /**
   * Toggle visibility
   */
  function toggle(): void {
    visible = !visible;
    scrollOffset = 0;
  }

  /**
   * Check if visible
   */
  function isVisible(): boolean {
    return visible;
  }

  /**
   * Show the quest log
   */
  function show(): void {
    visible = true;
    scrollOffset = 0;
  }

  /**
   * Hide the quest log
   */
  function hide(): void {
    visible = false;
  }

  /**
   * Handle key events
   */
  function handleKey(key: string): boolean {
    if (!visible) return false;

    const tasks = taskWatcher.getTasks();

    if (key === 't' || key === 'ESCAPE') {
      hide();
      return true;
    }

    if (key === 'j' || key === 'DOWN') {
      if (scrollOffset < tasks.length - MAX_VISIBLE_TASKS) {
        scrollOffset++;
      }
      return true;
    }

    if (key === 'k' || key === 'UP') {
      if (scrollOffset > 0) {
        scrollOffset--;
      }
      return true;
    }

    return false;
  }

  return {
    draw,
    toggle,
    isVisible,
    show,
    hide,
    handleKey,
  };
}
