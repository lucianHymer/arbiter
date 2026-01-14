/**
 * Title Screen (terminal-kit version)
 *
 * Displays ASCII art title "The Arbiter" and continues on any key press.
 * Uses terminal-kit for fullscreen rendering.
 */

import termKit from 'terminal-kit';
import { cycleMusicMode, getMusicMode, isSfxEnabled, playSfx, toggleSfx } from '../../sound.js';
import { DIM } from '../constants.js';
import { cleanupTerminal, exitTerminal } from '../terminal-cleanup.js';
import { RESET } from '../tileset.js';

const term = termKit.terminal;

// Fire gradient colors (top = bright, bottom = dark)
const FIRE_COLORS = [
  '\x1b[97;1m', // bright white
  '\x1b[93;1m', // bright yellow
  '\x1b[93;1m', // bright yellow
  '\x1b[33;1m', // yellow
  '\x1b[33m', // dark yellow
  '\x1b[38;5;208m', // orange
  '\x1b[38;5;208m', // orange
  '\x1b[38;5;202m', // dark orange
  '\x1b[91m', // bright red
  '\x1b[91m', // bright red
  '\x1b[31m', // red
  '\x1b[31m', // red
  '\x1b[38;5;124m', // dark red
  '\x1b[38;5;124m', // dark red
];

// ASCII art title (raw lines)
const TITLE_ART = [
  '                                                                                                                 ',
  '  /###           /  /                            ##                     /                                        ',
  ' /  ############/ #/                          /####                   #/          #                              ',
  '/     #########   ##                         /  ###                   ##         ###     #                       ',
  '#     /  #        ##                            /##                   ##          #     ##                       ',
  ' ##  /  ##        ##                           /  ##                  ##                ##                       ',
  '    /  ###        ##  /##      /##             /  ##     ###  /###    ## /###   ###   ######## /##  ###  /###    ',
  '   ##   ##        ## / ###    / ###           /    ##     ###/ #### / ##/ ###  / ### ######## / ###  ###/ #### / ',
  '   ##   ##        ##/   ###  /   ###          /    ##      ##   ###/  ##   ###/   ##    ##   /   ###  ##   ###/  ',
  '   ##   ##        ##     ## ##    ###        /      ##     ##         ##    ##    ##    ##  ##    ### ##         ',
  '   ##   ##        ##     ## ########         /########     ##         ##    ##    ##    ##  ########  ##         ',
  '    ##  ##        ##     ## #######         /        ##    ##         ##    ##    ##    ##  #######   ##         ',
  '     ## #      /  ##     ## ##              #        ##    ##         ##    ##    ##    ##  ##        ##         ',
  '      ###     /   ##     ## ####    /      /####      ##   ##         ##    /#    ##    ##  ####    / ##         ',
  '       ######/    ##     ##  ######/      /   ####    ## / ###         ####/      ### / ##   ######/  ###        ',
  '         ###       ##    ##   #####      /     ##      #/   ###         ###        ##/   ##   #####    ###       ',
  '                         /               #                                                                       ',
  '                        /                 ##                                                                     ',
  '                       /                                                                                         ',
  '                      /                                                                                          ',
];

/**
 * Shows the title screen using terminal-kit.
 * Continues to character select on any key press.
 *
 * @returns Promise<void> - Resolves when user presses any key
 */
export async function showTitleScreen(): Promise<void> {
  return new Promise((resolve) => {
    // Initialize terminal
    term.fullscreen(true);
    term.hideCursor();
    term.grabInput({ mouse: 'button' });

    // Get terminal dimensions
    let width = 180;
    let height = 50;
    if (typeof term.width === 'number' && Number.isFinite(term.width) && term.width > 0) {
      width = term.width;
    }
    if (typeof term.height === 'number' && Number.isFinite(term.height) && term.height > 0) {
      height = term.height;
    }

    // Calculate centering
    const artWidth = TITLE_ART[0].length;
    const artHeight = TITLE_ART.length;
    const contentHeight = artHeight + 4; // art + spacing + prompt
    const startX = Math.max(1, Math.floor((width - artWidth) / 2));
    const startY = Math.max(1, Math.floor((height - contentHeight) / 2));

    // Clear screen
    term.clear();

    // Draw title art (diagonal fire gradient - ~25 degrees, top-left to bottom-right)
    // Weight row more than col for shallower angle (row * 3 ≈ 25 degrees)
    const rowWeight = 6;
    const maxDiagonal = TITLE_ART.length * rowWeight + TITLE_ART[0].length;
    for (let row = 0; row < TITLE_ART.length; row++) {
      term.moveTo(startX, startY + row);
      let line = '';
      let lastColorIdx = -1;

      for (let col = 0; col < TITLE_ART[row].length; col++) {
        const diagonal = row * rowWeight + col;
        const colorIdx = Math.min(
          Math.floor((diagonal / maxDiagonal) * FIRE_COLORS.length),
          FIRE_COLORS.length - 1,
        );

        // Only add color code when it changes
        if (colorIdx !== lastColorIdx) {
          line += FIRE_COLORS[colorIdx];
          lastColorIdx = colorIdx;
        }
        line += TITLE_ART[row][col];
      }
      process.stdout.write(line + RESET);
    }

    function drawPromptAndSoundHint() {
      // Draw prompt (dim, centered below art)
      const prompt = 'Press any key to continue...';
      const promptX = Math.max(1, Math.floor((width - prompt.length) / 2));
      const promptY = startY + artHeight + 3;
      term.moveTo(promptX, promptY);
      process.stdout.write(`${DIM}${prompt}${RESET}`);

      // Sound hint - show current state with color (green=on, yellow=quiet, red=off)
      const musicMode = getMusicMode();
      const sfxOn = isSfxEnabled();
      const cGreen = '\x1b[1;92m'; // bold bright green
      const cYellow = '\x1b[1;93m'; // bold bright yellow
      const cRed = '\x1b[1;91m'; // bold bright red
      const musicLabel =
        musicMode === 'on'
          ? `${DIM}m:music(${cGreen}ON${RESET}${DIM}/quiet/off)`
          : musicMode === 'quiet'
            ? `${DIM}m:music(on/${cYellow}QUIET${RESET}${DIM}/off)`
            : `${DIM}m:music(on/quiet/${cRed}OFF${RESET}${DIM})`;
      const sfxLabel = sfxOn
        ? `${DIM}s:sfx(${cGreen}ON${RESET}${DIM}/off)`
        : `${DIM}s:sfx(on/${cRed}OFF${RESET}${DIM})`;
      const soundHint = `${musicLabel}  ${sfxLabel}${RESET}`;
      // Clear the area first to prevent trailing characters when label shrinks
      term.moveTo(width - 40, height);
      process.stdout.write(' '.repeat(40));
      term.moveTo(width - 40, height);
      process.stdout.write(soundHint);
    }

    drawPromptAndSoundHint();

    /**
     * Cleanup for screen transitions
     */
    function cleanup() {
      term.removeAllListeners('key');
      cleanupTerminal();
    }

    // Handle any key press
    term.on('key', (key: string) => {
      // Exit on quit keys
      if (key === 'CTRL_C' || key === 'CTRL_Z') {
        term.removeAllListeners('key');
        exitTerminal();
        process.exit(0);
      }

      // Sound toggles (don't continue)
      if (key === 'm') {
        cycleMusicMode();
        drawPromptAndSoundHint();
        return;
      }
      if (key === 's') {
        toggleSfx();
        drawPromptAndSoundHint();
        return;
      }

      // Any other key continues to character select
      playSfx('menuSelect');
      cleanup();
      resolve();
    });
  });
}

export default showTitleScreen;
