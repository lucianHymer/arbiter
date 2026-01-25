/**
 * Quest Log Overlay Module
 *
 * Full-screen roguelike-style task viewer with expand/collapse navigation.
 * Similar to Caves of Qud quest log UI.
 */

import type { Terminal } from 'terminal-kit';
import type { Task, TaskWatcher } from './taskWatcher.js';

// ============================================================================
// Types
// ============================================================================

export interface QuestLogDeps {
  term: Terminal;
  getTileset: () => unknown; // Not used in new implementation but kept for interface compat
  getLayout: () => LayoutInfo;
  taskWatcher: TaskWatcher;
}

export interface LayoutInfo {
  width: number;
  height: number;
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

// Status indicators
const STATUS_ICONS = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
};

// Colors
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const WHITE = '\x1b[97m';
const MAGENTA = '\x1b[35m';
const INVERSE = '\x1b[7m';

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a quest log overlay instance
 */
export function createQuestLog(deps: QuestLogDeps): QuestLog {
  const { term, getLayout, taskWatcher } = deps;

  // Internal state
  let visible = false;
  let scrollOffset = 0;
  let selectedIndex = 0;
  const expandedTasks: Set<string> = new Set(); // Task IDs that are expanded

  // ============================================================================
  // Helper Functions
  // ============================================================================

  /**
   * Get status color for a task
   */
  function getStatusColor(status: string): string {
    switch (status) {
      case 'completed':
        return GREEN;
      case 'in_progress':
        return YELLOW;
      default:
        return DIM;
    }
  }

  /**
   * Truncate text to fit width
   */
  function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 1) + '…';
  }

  /**
   * Wrap text to multiple lines
   */
  function wrapText(text: string, width: number): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length + word.length + 1 <= width) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
  }

  /**
   * Build the display lines for rendering
   */
  function buildDisplayLines(
    tasks: Task[],
    contentWidth: number,
  ): { lines: string[]; taskLineMap: number[] } {
    const lines: string[] = [];
    const taskLineMap: number[] = []; // Maps line index to task index (-1 for non-task lines)

    for (let taskIdx = 0; taskIdx < tasks.length; taskIdx++) {
      const task = tasks[taskIdx];
      const isSelected = taskIdx === selectedIndex;
      const isExpanded = expandedTasks.has(task.id);
      const statusIcon = STATUS_ICONS[task.status] || '?';
      const statusColor = getStatusColor(task.status);
      const expandIcon = isExpanded ? '[-]' : '[+]';

      // Owner tag
      let ownerTag = '';
      if (task.owner) {
        const orchMatch = task.owner.match(/[Oo]rchestrator\s*(\S+)/i);
        if (orchMatch) {
          ownerTag = ` ${CYAN}[Orch ${orchMatch[1]}]${RESET}`;
        } else if (task.owner.toLowerCase().includes('arbiter')) {
          ownerTag = ` ${YELLOW}[Arbiter]${RESET}`;
        }
      }

      // Main task line
      const prefix = `${MAGENTA}${expandIcon}${RESET} ${statusColor}${statusIcon}${RESET} `;
      const subjectMaxLen = contentWidth - 12 - (task.owner ? 12 : 0);
      const subject = truncate(task.subject, subjectMaxLen);

      let line = `${prefix}${WHITE}${subject}${RESET}${ownerTag}`;

      // Highlight selected line
      if (isSelected) {
        line = `${INVERSE}${line}${RESET}`;
      }

      lines.push(line);
      taskLineMap.push(taskIdx);

      // If expanded, show description indented
      if (isExpanded && task.description) {
        const descLines = wrapText(task.description, contentWidth - 6);
        for (const descLine of descLines) {
          lines.push(`${DIM}     ${descLine}${RESET}`);
          taskLineMap.push(-1); // Description lines don't map to tasks
        }
        // Add a blank line after description
        lines.push('');
        taskLineMap.push(-1);
      }
    }

    return { lines, taskLineMap };
  }

  // ============================================================================
  // Drawing
  // ============================================================================

  /**
   * Draw the quest log overlay (full screen)
   */
  function draw(): void {
    if (!visible) return;

    const layout = getLayout();
    const width = layout.width;
    const height = layout.height;
    const tasks = taskWatcher.getTasks();

    term.clear();

    // Calculate counts
    const completed = tasks.filter((t) => t.status === 'completed').length;
    const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
    const pending = tasks.filter((t) => t.status === 'pending').length;

    // Header
    term.moveTo(1, 1);
    process.stdout.write(`${MAGENTA}${INVERSE} QUEST LOG ${RESET}`);
    process.stdout.write(
      `${DIM}  ${completed} complete · ${inProgress} in progress · ${pending} pending${RESET}`,
    );

    // Separator
    term.moveTo(1, 2);
    process.stdout.write(`${DIM}${'─'.repeat(width - 1)}${RESET}`);

    const contentStartY = 3;
    const contentHeight = height - 4; // Leave room for header (2) and footer (2)
    const contentWidth = width - 2;

    if (tasks.length === 0) {
      term.moveTo(2, contentStartY);
      process.stdout.write(`${DIM}No active tasks${RESET}`);
    } else {
      // Build display lines
      const { lines, taskLineMap } = buildDisplayLines(tasks, contentWidth);

      // Find which line the selected task starts on
      let selectedLineStart = 0;
      for (let i = 0; i < lines.length; i++) {
        if (taskLineMap[i] === selectedIndex) {
          selectedLineStart = i;
          break;
        }
      }

      // Adjust scroll to keep selection visible
      if (selectedLineStart < scrollOffset) {
        scrollOffset = selectedLineStart;
      } else if (selectedLineStart >= scrollOffset + contentHeight) {
        scrollOffset = selectedLineStart - contentHeight + 1;
      }

      // Clamp scroll offset
      const maxScroll = Math.max(0, lines.length - contentHeight);
      scrollOffset = Math.min(scrollOffset, maxScroll);
      scrollOffset = Math.max(0, scrollOffset);

      // Render visible lines
      for (let i = 0; i < contentHeight; i++) {
        const lineIdx = scrollOffset + i;
        term.moveTo(2, contentStartY + i);
        if (lineIdx < lines.length) {
          const line = lines[lineIdx];
          // Truncate to fit width
          process.stdout.write(line.slice(0, width - 2));
        }
      }

      // Scroll indicator
      if (lines.length > contentHeight) {
        const scrollPercent = Math.round((scrollOffset / maxScroll) * 100);
        term.moveTo(width - 10, contentStartY);
        process.stdout.write(`${DIM}${scrollPercent}%${RESET}`);
      }
    }

    // Footer separator
    term.moveTo(1, height - 1);
    process.stdout.write(`${DIM}${'─'.repeat(width - 1)}${RESET}`);

    // Footer with keybinds
    term.moveTo(1, height);
    process.stdout.write(
      `${MAGENTA}${INVERSE} ↑/k ↓/j:navigate  →/l:expand  ←/h:collapse  space:toggle  q/t:close ${RESET}`,
    );
  }

  /**
   * Toggle visibility
   */
  function toggle(): void {
    if (visible) {
      hide();
    } else {
      show();
    }
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
    selectedIndex = 0;
    // Start with all collapsed
    expandedTasks.clear();
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
    if (tasks.length === 0) {
      // No tasks, only handle close
      if (key === 't' || key === 'q' || key === 'ESCAPE') {
        hide();
        return true;
      }
      return false;
    }

    const currentTask = tasks[selectedIndex];

    switch (key) {
      case 't':
      case 'q':
      case 'ESCAPE':
        hide();
        return true;

      case 'j':
      case 'DOWN':
        // Move selection down
        if (selectedIndex < tasks.length - 1) {
          selectedIndex++;
          draw();
        }
        return true;

      case 'k':
      case 'UP':
        // Move selection up
        if (selectedIndex > 0) {
          selectedIndex--;
          draw();
        }
        return true;

      case 'l':
      case 'RIGHT':
      case 'ENTER':
        // Expand selected task
        if (currentTask && !expandedTasks.has(currentTask.id)) {
          expandedTasks.add(currentTask.id);
          draw();
        }
        return true;

      case 'h':
      case 'LEFT':
        // Collapse selected task
        if (currentTask && expandedTasks.has(currentTask.id)) {
          expandedTasks.delete(currentTask.id);
          draw();
        }
        return true;

      case 'g':
        // Go to top
        selectedIndex = 0;
        scrollOffset = 0;
        draw();
        return true;

      case 'G':
        // Go to bottom
        selectedIndex = tasks.length - 1;
        draw();
        return true;

      case ' ':
        // Toggle expand/collapse
        if (currentTask) {
          if (expandedTasks.has(currentTask.id)) {
            expandedTasks.delete(currentTask.id);
          } else {
            expandedTasks.add(currentTask.id);
          }
          draw();
        }
        return true;

      default:
        return false;
    }
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
