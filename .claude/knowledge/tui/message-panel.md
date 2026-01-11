# Reusable renderMessagePanel for Tile-bordered Dialogs

RPG-style tile-bordered message panels for overlays and dialogs.

## Function Signature

```typescript
renderMessagePanel(tileset, textLines, widthTiles, heightTiles)
```

## Tile Usage

- Corners use dialogue tiles 38/39/48/49
- Vertical borders use bottom-half of top corner tiles (pixel rows 8-15)
- Middle rows use modulo to repeat border pattern

## Dimensions

Each tile = 16 chars wide × 8 char rows tall

| Height (tiles) | Char rows | Use case |
|---------------|-----------|----------|
| 2 | 16 | Small prompts |
| 3 | 24 | File pickers |
| 4+ | 32+ | Long content |

## Text Rendering

- Text automatically centered within interior area
- Helper function `createMiddleRowBorders()` handles vertical border segments
- Text area leaves 2 rows at top/bottom for borders

## Current Uses

- Requirements prompt overlay
- File picker overlay
- Rat transformation message

## Related Files

- src/tui/tui-termkit.ts
