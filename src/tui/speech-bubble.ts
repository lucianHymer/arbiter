// Speech bubble rendering for the RPG-style TUI
// Creates bordered message boxes with speaker-specific colors and optional tails

/**
 * Speaker types for speech bubbles
 */
export type Speaker = 'human' | 'arbiter' | 'orchestrator' | string;

/**
 * Box drawing characters for speech bubbles
 */
const BOX = {
  topLeft: '\u250C',     // ┌
  topRight: '\u2510',    // ┐
  bottomLeft: '\u2514',  // └
  bottomRight: '\u2518', // ┘
  horizontal: '\u2500',  // ─
  vertical: '\u2502',    // │
} as const;

/**
 * Get color tags for a speaker
 * @param speaker - The speaker type
 * @returns Object with open and close color tags
 */
function getColorTags(speaker: Speaker): { open: string; close: string } {
  switch (speaker) {
    case 'arbiter':
      return { open: '{yellow-fg}', close: '{/yellow-fg}' };
    case 'orchestrator':
      return { open: '{cyan-fg}', close: '{/cyan-fg}' };
    case 'human':
    default:
      // Human and unknown speakers use default (white/no color)
      return { open: '', close: '' };
  }
}

/**
 * Strip blessed color tags from a string
 * Handles patterns like: {color-fg}, {/color-fg}, {#hex-fg}, {/#hex-fg}, {bold}, {/bold}
 * @param text - String potentially containing color tags
 * @returns String with color tags removed
 */
export function stripColorTags(text: string): string {
  return text.replace(/\{[^}]+\}/g, '');
}

/**
 * Word wrap text to fit within a maximum width
 * Breaks on word boundaries when possible
 * @param text - The text to wrap
 * @param maxWidth - Maximum width per line (content only, not including borders)
 * @returns Array of wrapped lines
 */
export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) {
    return [text];
  }

  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (!word) continue;

    if (currentLine === '') {
      // First word of the line
      if (word.length > maxWidth) {
        // Word is longer than maxWidth, force break it
        let remaining = word;
        while (remaining.length > maxWidth) {
          lines.push(remaining.slice(0, maxWidth));
          remaining = remaining.slice(maxWidth);
        }
        currentLine = remaining;
      } else {
        currentLine = word;
      }
    } else if ((currentLine + ' ' + word).length <= maxWidth) {
      // Word fits on current line
      currentLine += ' ' + word;
    } else {
      // Word doesn't fit, start new line
      lines.push(currentLine);
      if (word.length > maxWidth) {
        // Word is longer than maxWidth, force break it
        let remaining = word;
        while (remaining.length > maxWidth) {
          lines.push(remaining.slice(0, maxWidth));
          remaining = remaining.slice(maxWidth);
        }
        currentLine = remaining;
      } else {
        currentLine = word;
      }
    }
  }

  // Don't forget the last line
  if (currentLine) {
    lines.push(currentLine);
  }

  // Handle empty input
  if (lines.length === 0) {
    lines.push('');
  }

  return lines;
}

/**
 * Create a speech bubble with box drawing characters
 * @param text - The message content
 * @param maxWidth - Maximum bubble width (default 40)
 * @param speaker - Speaker type for color styling ('human' | 'arbiter' | 'orchestrator' | string)
 * @returns Multi-line string with box drawing characters and color tags
 */
export function createSpeechBubble(
  text: string,
  maxWidth: number = 40,
  speaker: Speaker = 'human'
): string {
  // Account for borders: 2 chars for '| ' and ' |' = 4 chars total padding
  const contentWidth = maxWidth - 4;

  if (contentWidth <= 0) {
    throw new Error('maxWidth must be greater than 4 to accommodate borders');
  }

  // Wrap the text
  const lines = wrapText(text, contentWidth);

  // Calculate actual width based on longest line
  const actualContentWidth = Math.max(...lines.map(line => line.length));
  const bubbleWidth = actualContentWidth + 4; // Add border padding

  // Get color tags for the speaker
  const { open, close } = getColorTags(speaker);

  // Build the bubble
  const horizontalBorder = BOX.horizontal.repeat(bubbleWidth - 2);

  const topBorder = `${open}${BOX.topLeft}${horizontalBorder}${BOX.topRight}${close}`;
  const bottomBorder = `${open}${BOX.bottomLeft}${horizontalBorder}${BOX.bottomRight}${close}`;

  const contentLines = lines.map(line => {
    const paddedContent = line.padEnd(actualContentWidth);
    return `${open}${BOX.vertical}${close} ${paddedContent} ${open}${BOX.vertical}${close}`;
  });

  return [topBorder, ...contentLines, bottomBorder].join('\n');
}

/**
 * Add a left-pointing tail to a speech bubble
 * Adds '<<<---' pointing to the left of the bubble
 * @param bubble - The speech bubble string
 * @returns Bubble with tail added to the middle-left
 */
export function addTailLeft(bubble: string): string {
  const lines = bubble.split('\n');

  if (lines.length < 3) {
    return bubble; // Too small for a tail
  }

  // Add tail to the middle content line (or just after middle)
  const tailIndex = Math.floor(lines.length / 2);
  const tail = '\u25C4\u2500\u2500'; // ◄──

  // Insert tail before the line
  lines[tailIndex] = tail + lines[tailIndex];

  // Pad other lines to align
  const tailLength = stripColorTags(tail).length;
  for (let i = 0; i < lines.length; i++) {
    if (i !== tailIndex) {
      lines[i] = ' '.repeat(tailLength) + lines[i];
    }
  }

  return lines.join('\n');
}

/**
 * Add a right-pointing tail to a speech bubble
 * Adds '--->>>' pointing to the right of the bubble
 * @param bubble - The speech bubble string
 * @returns Bubble with tail added to the middle-right
 */
export function addTailRight(bubble: string): string {
  const lines = bubble.split('\n');

  if (lines.length < 3) {
    return bubble; // Too small for a tail
  }

  // Add tail to the middle content line (or just after middle)
  const tailIndex = Math.floor(lines.length / 2);
  const tail = '\u2500\u2500\u25BA'; // ──►

  // Append tail to the line
  lines[tailIndex] = lines[tailIndex] + tail;

  return lines.join('\n');
}

/**
 * Get the height of a speech bubble in lines
 * @param bubble - The speech bubble string
 * @returns Number of lines
 */
export function getBubbleHeight(bubble: string): number {
  return bubble.split('\n').length;
}

/**
 * Get the maximum width of a speech bubble (excluding color tags)
 * @param bubble - The speech bubble string
 * @returns Maximum line width in characters
 */
export function getBubbleWidth(bubble: string): number {
  const lines = bubble.split('\n');
  return Math.max(...lines.map(line => stripColorTags(line).length));
}
