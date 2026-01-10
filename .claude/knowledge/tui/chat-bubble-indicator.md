# Chat Bubble Indicator Implementation

Visual chat bubble overlay that appears on speakers when they post messages.

## Quarter Tile System (tileset.ts)

Added support for 8x8 quarter-tile extraction and compositing:

### Types and Constants

- `QuarterPosition`: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
- `TILE.CHAT_BUBBLE_QUARTERS = 267`: Tile containing quarter icons (chat bubble in top-right)

### Functions

- `extractQuarterTile(pixels, quarter)`: Extracts 8x8 pixel region from 16x16 tile
- `compositeQuarterTile(base, quarter, position, alphaThreshold)`: Overlays 8x8 quarter onto 16x16 tile at specified corner

## Scene State (scene.ts)

### New State Property

```typescript
chatBubbleTarget: 'human' | 'arbiter' | 'conjuring' | null
```

### Helper Functions

- `getChatBubblePosition()`: Maps target to row/col position in scene
- `getChatBubbleQuarter()`: Caches the extracted bubble quarter tile
- `renderScene()`: Now takes optional `sceneState` parameter to apply bubble overlay

## TUI Integration (tui-termkit.ts)

### State Tracking

- `chatBubbleStartTime: number` added to TUIState for timing

### Behavior

1. `addMessage()` sets the bubble target based on speaker (human/arbiter/orchestrator)
2. Animation loop checks elapsed time and clears bubble after 5 seconds
3. New messages automatically replace previous bubble (showing new speaker)

## Related Files

- src/tui/tileset.ts
- src/tui/scene.ts
- src/tui/tui-termkit.ts
