# ForestIntro Dialogue Box Positioning

**Date discovered:** 2026-01-08

## The Problem

The dialogue box was positioned at `sceneOffsetY + SCENE_HEIGHT_CHARS` which placed it completely below the scene (40 rows down), making it invisible or off-screen.

## The Fix

Position the dialogue box to cover the bottom 3 tile rows of the scene:

```typescript
const dialogueY = sceneOffsetY + (SCENE_HEIGHT_CHARS - 24);
```

## Why This Works

- Scene is 5 tiles tall = 40 character rows total (5 tiles x 8 rows/tile)
- Bottom 3 tiles = 24 character rows (3 tiles x 8 rows/tile)
- `SCENE_HEIGHT_CHARS - 24 = 40 - 24 = 16`
- This places dialogue 16 rows from the top of the scene
- The dialogue overlay then covers the bottom portion of the scene

## Related Files

- src/tui/screens/ForestIntro-termkit.ts (lines 619-621)
