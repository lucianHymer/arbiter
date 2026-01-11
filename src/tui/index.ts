/**
 * TUI module entry point
 * RPG-style terminal interface with wizard council theme
 *
 * This module uses a terminal-kit based implementation with Strategy 5
 * (minimal redraws) for flicker-free animation and input handling.
 */

// Re-export the terminal-kit based TUI
export { createTUI, type TUI } from './tui-termkit.js';

// Re-export the terminal-kit based TitleScreen
export { showTitleScreen } from './screens/TitleScreen-termkit.js';

// Re-export the terminal-kit based ForestIntro
export { showForestIntro } from './screens/ForestIntro-termkit.js';

// Re-export the terminal-kit based CharacterSelect
export { showCharacterSelect, type CharacterSelectResult } from './screens/CharacterSelect-termkit.js';

// Re-export the terminal-kit based GitignoreCheck
export { checkGitignore } from './screens/GitignoreCheck-termkit.js';

// Re-export types for consumers
export type { RouterCallbacks, DebugLogEntry } from '../router.js';
export type { WaitingState } from './types.js';
