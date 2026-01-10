### [23:05] [tui] Chat bubble indicator using quarter tiles
**Details**: Implemented a chat bubble indicator that overlays on speakers when they post messages.

**Quarter Tile Functions (tileset.ts)**:
- `QuarterPosition` type: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
- `extractQuarterTile(pixels, quarter)`: Extracts 8x8 from 16x16 tile
- `compositeQuarterTile(base, quarter, position, alphaThreshold)`: Overlays 8x8 onto 16x16 at specified corner
- `TILE.CHAT_BUBBLE_QUARTERS = 267`: Tile containing quarter icons (chat bubble in top-right)

**Scene State (scene.ts)**:
- Added `chatBubbleTarget: 'human' | 'arbiter' | 'conjuring' | null` to SceneState
- `getChatBubblePosition()`: Maps target to row/col position
- `getChatBubbleQuarter()`: Caches the bubble quarter tile extraction
- `renderScene()` now takes optional `sceneState` parameter to apply bubble overlay

**TUI Integration (tui-termkit.ts)**:
- Added `chatBubbleStartTime` to TUIState for timing
- `addMessage()` sets the bubble target based on speaker (human/arbiter/orchestrator)
- Animation loop clears bubble after 5 seconds
- New messages automatically replace previous bubble (showing new speaker)
**Files**: src/tui/tileset.ts, src/tui/scene.ts, src/tui/tui-termkit.ts
---

