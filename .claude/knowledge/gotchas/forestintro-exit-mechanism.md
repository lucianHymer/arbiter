# ForestIntro Exit Mechanism - Walk Off Screen

**Date discovered:** 2026-01-08

## The Behavior

In ForestIntro-termkit.ts, the player must walk **OFF the screen** to the right (x >= SCENE_WIDTH_TILES) to successfully exit - not just reach the rightmost walkable tile.

## Key Implementation Details

1. No EXIT tile type in collision map at rightmost position (row=2, col=6)
2. `isExit()` function always returns false (kept for compatibility)
3. Exit logic in keyboard handler checks: `newX >= SCENE_WIDTH_TILES && newY === START_Y && state.hasSeenSign`
4. Exit check is separate from movement validation

## Exit Conditions

- **SUCCESS**: Player moves right past SCENE_WIDTH_TILES (7) on path row (y===2) with `hasSeenSign=true`
- **DEATH**: Any other attempt to move off-screen edge, or off-screen without `hasSeenSign=true`

## Important Note

The player can walk all the way across the path (tiles 0-6) without exiting. They must continue moving right **past** tile 6 to trigger the exit. This creates a deliberate "step into the unknown" moment.

## Related Files

- src/tui/screens/ForestIntro-termkit.ts
