/**
 * Title Screen (terminal-kit version)
 *
 * Displays ASCII art title "The Arbiter" and continues on any key press.
 * Uses terminal-kit for fullscreen rendering.
 */

import termKit from 'terminal-kit';

const term = termKit.terminal;

// ANSI codes
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// Fire gradient colors (top = bright, bottom = dark)
const FIRE_COLORS = [
  '\x1b[97;1m', // bright white
  '\x1b[93;1m', // bright yellow
  '\x1b[93;1m', // bright yellow
  '\x1b[33;1m', // yellow
  '\x1b[33m',   // dark yellow
  '\x1b[38;5;208m', // orange
  '\x1b[38;5;208m', // orange
  '\x1b[38;5;202m', // dark orange
  '\x1b[91m',   // bright red
  '\x1b[91m',   // bright red
  '\x1b[31m',   // red
  '\x1b[31m',   // red
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
    if (typeof term.width === 'number' && isFinite(term.width) && term.width > 0) {
      width = term.width;
    }
    if (typeof term.height === 'number' && isFinite(term.height) && term.height > 0) {
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
          FIRE_COLORS.length - 1
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

    // Draw prompt (dim, centered below art)
    const prompt = 'Press any key to continue...';
    const promptX = Math.max(1, Math.floor((width - prompt.length) / 2));
    const promptY = startY + artHeight + 3;
    term.moveTo(promptX, promptY);
    process.stdout.write(`${DIM}${prompt}${RESET}`);

    /**
     * Cleanup and restore terminal
     */
    function cleanup() {
      term.removeAllListeners('key');
      term.grabInput(false);
      term.fullscreen(false);
      term.hideCursor(false);
    }

    // Handle any key press
    term.on('key', (key: string) => {
      // Exit on quit keys
      if (key === 'CTRL_C' || key === 'CTRL_Z') {
        cleanup();
        process.exit(0);
      }

      // Any other key continues to character select
      cleanup();
      resolve();
    });
  });
}

export default showTitleScreen;
