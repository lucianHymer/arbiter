### [22:31] [gotcha] ForestIntro Exit Mechanism - Walk Off Screen
**Details**: Updated ForestIntro-termkit.ts to require player walk OFF the screen to the right (x >= SCENE_WIDTH_TILES) to successfully exit, not just reach the rightmost walkable tile.

Key changes:
1. Removed EXIT tile type from collision map at (row=2, col=6)
2. isExit() function now always returns false (kept for compatibility)
3. Exit logic in keyboard handler checks: newX >= SCENE_WIDTH_TILES && newY === START_Y && state.hasSeenSign
4. Removed separate isExit() check in movement validation
5. Only valid exit is: moving right off screen on path row (y===2) after seeing sign

Exit conditions:
- SUCCESS: Player moves right past SCENE_WIDTH_TILES (7) on path row with hasSeenSign=true
- DEATH: Any other attempt to move off-screen edge, or off-screen without hasSeenSign=true

The player can walk all the way across the path (tiles 0-6) without exiting, must continue moving right past tile 6 to trigger the exit.
**Files**: src/tui/screens/ForestIntro-termkit.ts
---

### [22:42] [fix] Fixed dialogue box Y positioning in ForestIntro screen
**Details**: The dialogue box was positioned at `sceneOffsetY + SCENE_HEIGHT_CHARS` which placed it completely below the scene (40 rows down). Fixed to position it to cover the bottom 3 tile rows of the scene by using `sceneOffsetY + (SCENE_HEIGHT_CHARS - 24)`. This places the dialogue 16 rows from the top of the scene (40 - 24 = 16), which covers the bottom 3 tiles (3 tiles × 8 rows/tile = 24 rows). Scene is 5 tiles tall at 40 character rows total.
**Files**: src/tui/screens/ForestIntro-termkit.ts (lines 619-621)
---

