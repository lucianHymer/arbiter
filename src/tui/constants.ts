/**
 * Shared constants for the TUI module
 */

import * as path from 'node:path';

// ============================================================================
// File Paths
// ============================================================================

/** Debug log file path (temporary, cleared each session) */
export const DEBUG_LOG_PATH = path.join(process.cwd(), '.claude', 'arbiter.tmp.log');

// ============================================================================
// ANSI Escape Codes
// ============================================================================

// Note: RESET is exported from tileset.ts to avoid duplication

// Text styles
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';

// Basic colors
export const BLACK = '\x1b[30m';
export const RED = '\x1b[31m';
export const GREEN = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const BLUE = '\x1b[34m';
export const MAGENTA = '\x1b[35m';
export const CYAN = '\x1b[36m';
export const WHITE = '\x1b[37m';
export const BRIGHT_WHITE = '\x1b[97m';
