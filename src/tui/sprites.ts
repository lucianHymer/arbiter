// ASCII sprite definitions for the RPG-style TUI
// Contains character art, campfire frames, and decorative elements

/**
 * THE DRACONIC HORROR - The Arbiter
 * A menacing dragon-like entity overseeing the wizard's circle
 */
export const ARBITER_SPRITE = `\u00A0\u00A0\u00A0\u00A0{red-fg}\u25B2{/red-fg} {yellow-fg}\u2699{/yellow-fg} {red-fg}\u25B2{/red-fg}
\u00A0\u00A0\u00A0\u00A0{#FF6600-fg}\u2571{/#FF6600-fg}{red-fg}\u25C9\u25C9\u25C9{/red-fg}{#FF6600-fg}\u2572{/#FF6600-fg}
\u00A0\u00A0\u00A0{#FF6600-fg}\u2593{/#FF6600-fg}{yellow-fg}\u25C8{/yellow-fg}{red-fg}\u2588\u2588\u2588{/red-fg}{yellow-fg}\u25C8{/yellow-fg}{#FF6600-fg}\u2593{/#FF6600-fg}
\u00A0\u00A0{yellow-fg}\u2571{/yellow-fg}{#FF6600-fg}\u2593{/#FF6600-fg}{red-fg}\u25BC\u2588\u2588\u2588\u25BC{/red-fg}{#FF6600-fg}\u2593{/#FF6600-fg}{yellow-fg}\u2572{/yellow-fg}
\u00A0{yellow-fg}\u2571{/yellow-fg} {red-fg}\u2554\u2550\u2550\u2550\u2550\u2550\u2557{/red-fg} {yellow-fg}\u2572{/yellow-fg}
{#FF6600-fg}\u2571{/#FF6600-fg}  {red-fg}\u2551\u2593\u2593\u2593\u2593\u2593\u2551{/red-fg}  {#FF6600-fg}\u2572{/#FF6600-fg}
{yellow-fg}\u2588{/yellow-fg}  {red-fg}\u2551\u2593{/red-fg}{#FF6600-fg}\u25C9{/#FF6600-fg}{red-fg}\u2593{/red-fg}{#FF6600-fg}\u25C9{/#FF6600-fg}{red-fg}\u2593\u2551{/red-fg}  {yellow-fg}\u2588{/yellow-fg}
{#FF6600-fg}\u2572{/#FF6600-fg}  {red-fg}\u255A\u2550\u2550\u25BC\u2550\u2550\u255D{/red-fg}  {#FF6600-fg}\u2571{/#FF6600-fg}
\u00A0{yellow-fg}\u2572{/yellow-fg}  {#8B4513-fg}\u2588{/#8B4513-fg}{red-fg}\u2593\u2593\u2593{/red-fg}{#8B4513-fg}\u2588{/#8B4513-fg}  {yellow-fg}\u2571{/yellow-fg}
\u00A0\u00A0{#8B4513-fg}\u2572{/#8B4513-fg} {red-fg}\u2588{/red-fg} {#FF6600-fg}\u25B2{/#FF6600-fg} {red-fg}\u2588{/red-fg} {#8B4513-fg}\u2571{/#8B4513-fg}
\u00A0\u00A0\u00A0{#8B4513-fg}\u255A\u2550\u2550\u2550\u2550\u2550\u255D{/#8B4513-fg}`;

/**
 * Wizard/Orchestrator sprite
 * Creates a wizard with animated gem staff and Roman numeral label
 *
 * @param romanNumeral - The wizard's designation (I, II, III, IV, V, etc.)
 * @param isActive - Whether the wizard is currently working
 * @param gemFrame - Animation frame for the gem (0-3)
 */
export function createWizardSprite(romanNumeral: string, isActive: boolean, gemFrame: number = 0): string {
  // Gem animation frames - gem moves along the staff
  const gemPatterns = [
    ['\u25C7', '\u25C7', '\u25C7'],  // Frame 0: all empty
    ['\u25C6', '\u25C7', '\u25C7'],  // Frame 1: top lit
    ['\u25C7', '\u25C6', '\u25C7'],  // Frame 2: middle lit
    ['\u25C7', '\u25C7', '\u25C6'],  // Frame 3: bottom lit
  ];

  const pattern = isActive ? gemPatterns[gemFrame % 4] : gemPatterns[0];
  const color = isActive ? 'cyan' : '#666666';
  const startTag = `{${color}-fg}`;
  const endTag = `{/${color}-fg}`;

  // Wizard with pointed hat, robe, and gem staff
  return `
${startTag}\u00A0\u00A0\u00A0${pattern[0]}${endTag}
${startTag}\u00A0\u00A0/ \\${endTag}
${startTag}\u00A0/\u2593\u2593\\${endTag}
${startTag}/\u2593\u2593\u2593\u2593\\${endTag}
${startTag}\u2502\u2588\u25CF\u25CF\u2588\u2502${endTag}
${startTag}\u2502\u2588\u2588\u2588\u2588\u2502${endTag}
${startTag}\u00A0\u2588  \u2588${endTag}
${startTag}\u00A0\u00A0${romanNumeral.padStart(2, ' ')}${endTag}
`.trim();
}

/**
 * Campfire animation frames - active burning
 * Fast animation for when work is being done
 */
export const CAMPFIRE_FRAMES = [
  // Frame 0 - flames reaching left
  `\u00A0\u00A0\u00A0\u00A0{yellow-fg}\\{/yellow-fg} {red-fg}*{/red-fg}
\u00A0\u00A0\u00A0{yellow-fg}\\{/yellow-fg}{#FF6600-fg}({/#FF6600-fg}{red-fg}~{/red-fg}{#FF6600-fg}){/#FF6600-fg}{yellow-fg}/{/yellow-fg}
\u00A0\u00A0{#FF6600-fg}\\{/#FF6600-fg}{red-fg}(~*~){/red-fg}{#FF6600-fg}/{/#FF6600-fg}
\u00A0\u00A0\u00A0{red-fg}\\{/red-fg}{#FF6600-fg}\u2593\u2593\u2593{/#FF6600-fg}{red-fg}/{/red-fg}
\u00A0\u00A0\u00A0\u00A0{#8B4513-fg}\u2588\u2588\u2588{/#8B4513-fg}`,

  // Frame 1 - flames reaching up
  `\u00A0\u00A0\u00A0\u00A0\u00A0{yellow-fg}*{/yellow-fg}
\u00A0\u00A0\u00A0{red-fg}*{/red-fg}{#FF6600-fg}({/#FF6600-fg}{yellow-fg}~{/yellow-fg}{#FF6600-fg}){/#FF6600-fg}{red-fg}*{/red-fg}
\u00A0\u00A0{#FF6600-fg}\\{/#FF6600-fg}{yellow-fg}(*~*){/yellow-fg}{#FF6600-fg}/{/#FF6600-fg}
\u00A0\u00A0\u00A0{red-fg}\\{/red-fg}{#FF6600-fg}\u2593\u2593\u2593{/#FF6600-fg}{red-fg}/{/red-fg}
\u00A0\u00A0\u00A0\u00A0{#8B4513-fg}\u2588\u2588\u2588{/#8B4513-fg}`,

  // Frame 2 - flames reaching right
  `\u00A0\u00A0\u00A0\u00A0{red-fg}*{/red-fg} {yellow-fg}/{/yellow-fg}
\u00A0\u00A0{yellow-fg}\\{/yellow-fg}{#FF6600-fg}({/#FF6600-fg}{red-fg}~{/red-fg}{#FF6600-fg}){/#FF6600-fg}{yellow-fg}/{/yellow-fg}
\u00A0\u00A0{#FF6600-fg}\\{/#FF6600-fg}{red-fg}(~*~){/red-fg}{#FF6600-fg}/{/#FF6600-fg}
\u00A0\u00A0\u00A0{red-fg}\\{/red-fg}{#FF6600-fg}\u2593\u2593\u2593{/#FF6600-fg}{red-fg}/{/red-fg}
\u00A0\u00A0\u00A0\u00A0{#8B4513-fg}\u2588\u2588\u2588{/#8B4513-fg}`,

  // Frame 3 - flames crackling
  `\u00A0\u00A0\u00A0\u00A0{yellow-fg}*{/yellow-fg} {yellow-fg}*{/yellow-fg}
\u00A0\u00A0{#FF6600-fg}\\{/#FF6600-fg}{red-fg}({/red-fg}{yellow-fg}~{/yellow-fg}{red-fg}){/red-fg}{#FF6600-fg}/{/#FF6600-fg}
\u00A0\u00A0{red-fg}\\{/red-fg}{#FF6600-fg}(~*~){/#FF6600-fg}{red-fg}/{/red-fg}
\u00A0\u00A0\u00A0{#FF6600-fg}\\{/#FF6600-fg}{red-fg}\u2593\u2593\u2593{/red-fg}{#FF6600-fg}/{/#FF6600-fg}
\u00A0\u00A0\u00A0\u00A0{#8B4513-fg}\u2588\u2588\u2588{/#8B4513-fg}`,
];

/**
 * Campfire frames for when system is idle
 * Slow ember animation - just glowing coals
 */
export const CAMPFIRE_IDLE_FRAMES = [
  // Frame 0 - low embers
  `
\u00A0\u00A0\u00A0\u00A0\u00A0{#FF6600-fg}\xB7{/#FF6600-fg}
\u00A0\u00A0\u00A0{red-fg}(\xB7\xB7){/red-fg}
\u00A0\u00A0\u00A0{#8B4513-fg}\\\u2593\u2593\u2593/{/#8B4513-fg}
\u00A0\u00A0\u00A0\u00A0{#8B4513-fg}\u2588\u2588\u2588{/#8B4513-fg}`,

  // Frame 1 - ember glow
  `
\u00A0\u00A0\u00A0\u00A0\u00A0{red-fg}*{/red-fg}
\u00A0\u00A0\u00A0{#FF6600-fg}(\xB7*){/#FF6600-fg}
\u00A0\u00A0\u00A0{#8B4513-fg}\\\u2593\u2593\u2593/{/#8B4513-fg}
\u00A0\u00A0\u00A0\u00A0{#8B4513-fg}\u2588\u2588\u2588{/#8B4513-fg}`,
];

/**
 * Subagent sprite (small helper that appears briefly)
 */
export const SUBAGENT_SPRITE = `
{cyan-fg}\xB7\u25E6\xB7{/cyan-fg}
{cyan-fg}\u25AA\u25AB\u25AA{/cyan-fg}
`.trim();

/**
 * THE HUMAN - A humble mortal speaking to the Arbiter
 * Simple figure appearing on the left side during human input
 */
export const HUMAN_SPRITE = `\u00A0\u00A0\u00A0o
\u00A0\u00A0/█\\
\u00A0\u00A0/█\\
\u00A0\u00A0\u00A0█
\u00A0\u00A0/\u00A0\\`;

/**
 * Arrow indicators for message flow
 */
export const ARROW_LEFT = '{gray-fg}\u25C4\u2500\u2500\u2500\u2500{/gray-fg}';
export const ARROW_RIGHT = '{gray-fg}\u2500\u2500\u2500\u2500\u25BA{/gray-fg}';

/**
 * Scene title - THE WIZARD'S CIRCLE in brown/gold
 */
export const SCENE_TITLE = `{bold}{#DAA520-fg}THE WIZARD'S CIRCLE{/#DAA520-fg}{/bold}`;

/**
 * Secondary title styling (brown)
 */
export const SCENE_TITLE_ALT = `{bold}{#8B4513-fg}THE WIZARD'S CIRCLE{/#8B4513-fg}{/bold}`;

/**
 * Get the height of a sprite in lines
 * @param sprite - The sprite string
 * @returns Number of lines
 */
export function getSpriteHeight(sprite: string): number {
  return sprite.split('\n').length;
}

/**
 * Get the width of a sprite (max line length excluding color tags)
 * @param sprite - The sprite string
 * @returns Maximum line width
 */
export function getSpriteWidth(sprite: string): number {
  const lines = sprite.split('\n');
  return Math.max(...lines.map(line => {
    // Strip blessed color tags: {color-fg}, {/color-fg}, {#hex-fg}, {/#hex-fg}, {bold}, {/bold}
    const stripped = line.replace(/\{[^}]+\}/g, '');
    return stripped.length;
  }));
}

/**
 * Calculate wizard positions in a semi-circle around the campfire
 * Wizards are arranged in an arc on the right side of the fire
 *
 * @param index - The wizard's index (0-based)
 * @param total - Total number of wizards
 * @returns Position offset from the campfire center
 */
export function getWizardPosition(index: number, total: number): { x: number; y: number } {
  // For a semi-circle arrangement, calculate positions based on angle
  // Angle range: -60 to +60 degrees (120 degree arc)
  const startAngle = -60 * (Math.PI / 180);
  const endAngle = 60 * (Math.PI / 180);
  const radius = 12; // Distance from campfire center

  // Calculate angle for this wizard
  let angle: number;
  if (total === 1) {
    angle = 0; // Single wizard directly to the right
  } else {
    // Distribute evenly across the arc
    const step = (endAngle - startAngle) / (total - 1);
    angle = startAngle + (index * step);
  }

  // Convert to x, y coordinates
  // x is positive (to the right of fire)
  // y varies based on angle (negative = up, positive = down)
  const x = Math.round(Math.cos(angle) * radius);
  const y = Math.round(Math.sin(angle) * radius / 2); // Divide by 2 because terminal chars are taller than wide

  return { x, y };
}

/**
 * Predefined wizard positions for common counts (fallback)
 * Use when you want consistent positioning
 * Increased x values by 4 units for more space between wizard and fire
 */
export const WIZARD_POSITIONS: Record<number, Array<{ x: number; y: number }>> = {
  1: [{ x: 35, y: 0 }],
  2: [
    { x: 33, y: -3 },
    { x: 33, y: 3 },
  ],
  3: [
    { x: 30, y: -4 },
    { x: 35, y: 0 },
    { x: 30, y: 4 },
  ],
  4: [
    { x: 28, y: -5 },
    { x: 35, y: -2 },
    { x: 35, y: 2 },
    { x: 28, y: 5 },
  ],
  5: [
    { x: 26, y: -5 },
    { x: 32, y: -3 },
    { x: 38, y: 0 },
    { x: 32, y: 3 },
    { x: 26, y: 5 },
  ],
};

/**
 * Get wizard position using predefined positions if available
 * Falls back to calculated positions
 */
export function getWizardPositionPredefined(index: number, total: number): { x: number; y: number } {
  const positions = WIZARD_POSITIONS[total];
  if (positions && index < positions.length) {
    return positions[index];
  }
  // Fall back to calculated position
  return getWizardPosition(index, total);
}
