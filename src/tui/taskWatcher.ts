/**
 * Task Watcher Module
 *
 * Monitors the Claude Code task list directory for changes and provides
 * real-time task state to the TUI. Tasks are stored in ~/.claude/tasks/<task-list-id>/
 */

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

// ============================================================================
// Types
// ============================================================================

/**
 * Task status - matches Claude Code's task system
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed';

/**
 * A single task from the task list
 */
export interface Task {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
}

/**
 * Callback for task updates
 */
export type TaskUpdateCallback = (tasks: Task[]) => void;

/**
 * Task watcher instance
 */
export interface TaskWatcher {
  /** Start watching for task changes */
  start: () => void;
  /** Stop watching */
  stop: () => void;
  /** Get current tasks */
  getTasks: () => Task[];
  /** Register a callback for task updates */
  onUpdate: (callback: TaskUpdateCallback) => void;
  /** Get the task list ID being watched */
  getTaskListId: () => string | null;
}

// ============================================================================
// Constants
// ============================================================================

const TASKS_BASE_DIR = path.join(homedir(), '.claude', 'tasks');
const POLL_INTERVAL_MS = 1000; // Poll every second for changes

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a task watcher that monitors the shared task list directory.
 *
 * @param taskListId - Optional specific task list ID. If not provided, uses CLAUDE_CODE_TASK_LIST_ID env var.
 */
export function createTaskWatcher(taskListId?: string): TaskWatcher {
  // Resolve task list ID from parameter or environment
  const resolvedTaskListId = taskListId || process.env.CLAUDE_CODE_TASK_LIST_ID || null;

  // Internal state
  let tasks: Task[] = [];
  let pollInterval: NodeJS.Timeout | null = null;
  let lastModTime = 0;
  const callbacks: TaskUpdateCallback[] = [];

  /**
   * Get the task list directory path
   */
  function getTaskDir(): string | null {
    if (!resolvedTaskListId) return null;
    return path.join(TASKS_BASE_DIR, resolvedTaskListId);
  }

  /**
   * Read and parse all tasks from the task directory
   */
  function readTasks(): Task[] {
    const taskDir = getTaskDir();
    if (!taskDir) return [];

    try {
      if (!fs.existsSync(taskDir)) {
        return [];
      }

      const files = fs.readdirSync(taskDir).filter((f) => f.endsWith('.json'));
      const parsedTasks: Task[] = [];

      for (const file of files) {
        try {
          const filePath = path.join(taskDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const task = JSON.parse(content) as Task;
          parsedTasks.push(task);
        } catch {
          // Skip files that can't be parsed
        }
      }

      // Sort by ID (numeric) for consistent ordering
      parsedTasks.sort((a, b) => {
        const aNum = parseInt(a.id, 10) || 0;
        const bNum = parseInt(b.id, 10) || 0;
        return aNum - bNum;
      });

      return parsedTasks;
    } catch {
      return [];
    }
  }

  /**
   * Check for directory modification and update tasks if changed
   */
  function checkForChanges(): void {
    const taskDir = getTaskDir();
    if (!taskDir) return;

    try {
      // Check if directory exists
      if (!fs.existsSync(taskDir)) {
        if (tasks.length > 0) {
          tasks = [];
          notifyCallbacks();
        }
        return;
      }

      // Get directory modification time
      const stat = fs.statSync(taskDir);
      const modTime = stat.mtimeMs;

      // Also check individual file mod times (directory mtime doesn't always update on file changes)
      let latestFileTime = modTime;
      try {
        const files = fs.readdirSync(taskDir).filter((f) => f.endsWith('.json'));
        for (const file of files) {
          const fileStat = fs.statSync(path.join(taskDir, file));
          latestFileTime = Math.max(latestFileTime, fileStat.mtimeMs);
        }
      } catch {
        // Ignore errors reading individual files
      }

      // If directory or files changed, re-read tasks
      if (latestFileTime > lastModTime) {
        lastModTime = latestFileTime;
        const newTasks = readTasks();

        // Only notify if tasks actually changed
        if (JSON.stringify(newTasks) !== JSON.stringify(tasks)) {
          tasks = newTasks;
          notifyCallbacks();
        }
      }
    } catch {
      // Ignore errors during polling
    }
  }

  /**
   * Notify all registered callbacks of task updates
   */
  function notifyCallbacks(): void {
    for (const callback of callbacks) {
      try {
        callback(tasks);
      } catch {
        // Ignore callback errors
      }
    }
  }

  /**
   * Start watching for task changes
   */
  function start(): void {
    if (pollInterval) return; // Already running

    // Initial read
    tasks = readTasks();
    lastModTime = Date.now();
    notifyCallbacks();

    // Start polling
    pollInterval = setInterval(checkForChanges, POLL_INTERVAL_MS);
  }

  /**
   * Stop watching
   */
  function stop(): void {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  /**
   * Get current tasks
   */
  function getTasks(): Task[] {
    return [...tasks];
  }

  /**
   * Register a callback for task updates
   */
  function onUpdate(callback: TaskUpdateCallback): void {
    callbacks.push(callback);
  }

  /**
   * Get the task list ID being watched
   */
  function getTaskListId(): string | null {
    return resolvedTaskListId;
  }

  return {
    start,
    stop,
    getTasks,
    onUpdate,
    getTaskListId,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a new task list ID (UUID v4 format)
 */
export function generateTaskListId(): string {
  // Simple UUID v4 generation
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
