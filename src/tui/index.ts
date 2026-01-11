/**
 * TUI module entry point
 * RPG-style terminal interface with wizard council theme
 *
 * This module uses a terminal-kit based implementation with Strategy 5
 * (minimal redraws) for flicker-free animation and input handling.
 */

// Re-export types for consumers
export type { DebugLogEntry, RouterCallbacks } from '../router.js';
// Re-export the terminal-kit based CharacterSelect
export {
  type CharacterSelectResult,
  showCharacterSelect,
} from './screens/CharacterSelect-termkit.js';

// Re-export the terminal-kit based ForestIntro
export { showForestIntro } from './screens/ForestIntro-termkit.js';
// Re-export the terminal-kit based GitignoreCheck
export { checkGitignore } from './screens/GitignoreCheck-termkit.js';
// Re-export the terminal-kit based TitleScreen
export { showTitleScreen } from './screens/TitleScreen-termkit.js';
// Re-export the terminal-kit based TUI
export { createTUI, type TUI } from './tui-termkit.js';
export type { WaitingState } from './types.js';
