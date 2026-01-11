/**
 * Gitignore Check Screen (terminal-kit version)
 *
 * Checks if Arbiter's generated files are gitignored in the user's project.
 * If not, prompts user to add them. Skips silently if not in a git repo.
 */

import termKit from 'terminal-kit';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const term = termKit.terminal;

// ANSI codes
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';

// Files that Arbiter creates and should be gitignored
const ARBITER_FILES = [
  '.claude/.arbiter-session.json',
  '.claude/arbiter.tmp.log',
];

// What to append to .gitignore
const GITIGNORE_ENTRIES = `
# Arbiter
.claude/.arbiter-session.json
.claude/arbiter.tmp.log
`;

/**
 * Check if we're in a git repository
 * @returns The git root path, or null if not in a repo
 */
function getGitRoot(): string | null {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return root;
  } catch {
    return null;
  }
}

/**
 * Check if a file is gitignored
 * @param filePath - Path to check (relative to git root)
 * @returns true if ignored, false if not
 */
function isGitignored(filePath: string): boolean {
  try {
    execSync(`git check-ignore -q ${filePath}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true; // exit code 0 = ignored
  } catch {
    return false; // exit code 1 = not ignored
  }
}

/**
 * Append entries to .gitignore file
 * @param gitRoot - Git repository root path
 */
function addToGitignore(gitRoot: string): void {
  const gitignorePath = path.join(gitRoot, '.gitignore');

  // Append to existing or create new
  fs.appendFileSync(gitignorePath, GITIGNORE_ENTRIES, 'utf-8');
}

/**
 * Shows the gitignore check prompt using terminal-kit.
 * Skips silently if not in a git repo or files are already ignored.
 *
 * @returns Promise<void> - Resolves when check is complete
 */
export async function checkGitignore(): Promise<void> {
  // Check if we're in a git repo
  const gitRoot = getGitRoot();
  if (!gitRoot) {
    return; // Not a git repo, skip silently
  }

  // Check which files are not gitignored
  const unignoredFiles = ARBITER_FILES.filter((file) => !isGitignored(file));

  if (unignoredFiles.length === 0) {
    return; // All files already ignored, skip silently
  }

  return new Promise((resolve) => {
    // Initialize terminal
    term.fullscreen(true);
    term.hideCursor();
    term.grabInput({ mouse: 'button' });

    // Get terminal dimensions
    let width = 180;
    let height = 50;
    if (typeof term.width === 'number' && isFinite(term.width) && term.width > 0) {
      width = term.width;
    }
    if (typeof term.height === 'number' && isFinite(term.height) && term.height > 0) {
      height = term.height;
    }

    // Content lines
    const lines = [
      'The Arbiter creates files that shouldn\'t be committed:',
      '',
      ...unignoredFiles.map((f) => `  ${f}`),
      '',
      'Add to .gitignore? [y/n]',
    ];

    // Calculate centering
    const maxLineWidth = Math.max(...lines.map((l) => l.length));
    const contentHeight = lines.length;
    const startX = Math.max(1, Math.floor((width - maxLineWidth) / 2));
    const startY = Math.max(1, Math.floor((height - contentHeight) / 2));

    // Clear screen
    term.clear();

    // Draw content
    lines.forEach((line, idx) => {
      term.moveTo(startX, startY + idx);
      if (idx === 0) {
        // Header in yellow
        process.stdout.write(`${YELLOW}${line}${RESET}`);
      } else if (line.startsWith('  ')) {
        // File paths dimmed
        process.stdout.write(`${DIM}${line}${RESET}`);
      } else if (line.includes('[y/n]')) {
        // Prompt
        process.stdout.write(line);
      } else {
        process.stdout.write(line);
      }
    });

    /**
     * Cleanup and restore terminal
     */
    function cleanup() {
      term.removeAllListeners('key');
      term.grabInput(false);
      term.fullscreen(false);
      term.hideCursor(false);
    }

    /**
     * Show brief success message
     */
    function showSuccess() {
      const msg = 'Added to .gitignore';
      const msgX = Math.max(1, Math.floor((width - msg.length) / 2));
      const msgY = startY + lines.length + 1;
      term.moveTo(msgX, msgY);
      process.stdout.write(`${GREEN}${msg}${RESET}`);

      // Brief pause so user sees the message
      setTimeout(() => {
        cleanup();
        resolve();
      }, 800);
    }

    // Handle key press
    term.on('key', (key: string) => {
      // Exit on quit keys
      if (key === 'CTRL_C' || key === 'CTRL_Z') {
        cleanup();
        process.exit(0);
      }

      // Yes - add to gitignore
      if (key === 'y' || key === 'Y') {
        try {
          addToGitignore(gitRoot);
          showSuccess();
        } catch {
          // Failed to write, just continue
          cleanup();
          resolve();
        }
        return;
      }

      // No - skip
      if (key === 'n' || key === 'N') {
        cleanup();
        resolve();
        return;
      }

      // Ignore other keys - wait for y/n
    });
  });
}

export default checkGitignore;
