# Sound Integration Requirements for Arbiter TUI

## Sound Assets

The project has WAV files in `/workspace/project/sounds/`:
- death.wav
- footstep.wav
- jump.wav
- magic.wav
- menu-left.wav
- menu-right.wav
- menu-select.wav
- quick-notice.wav

## Implementation Pattern

Create a `sound.ts` module following the `tileset.ts` pattern:
- Load sounds from assets directory
- Cache sounds after loading
- Provide playback functions

## Dependencies

No audio dependencies exist in package.json. Options:
- `play-sound`
- `node-wav`
- Platform-specific audio libraries

## Integration Points

### TitleScreen (TitleScreen-termkit.ts)
- Play sound on any key (lines 136-146)

### CharacterSelect (CharacterSelect-termkit.ts)
- `menu-left.wav` / `menu-right.wav` on arrow key navigation (lines 236-251)
- `menu-select.wav` on ENTER

### ForestIntro (ForestIntro-termkit.ts)
- `footstep.wav` on arrow key movement (lines 942-1017)
- `death.wav` on death
- `jump.wav` on successful exit

### Main TUI (tui-termkit.ts)
- `quick-notice.wav` in `addMessage()` (lines 928-957)
- `jump.wav` during hop animation (lines 1391-1447)
- `magic.wav` during demon spawn / `startSummonSequence()` (lines 1557-1607)
- `footstep.wav` during `animateArbiterWalk()` (lines 1509-1546)

## Related Files

- src/tui/tileset.ts (pattern reference)
- src/tui/tui-termkit.ts
- src/tui/screens/TitleScreen-termkit.ts
- src/tui/screens/CharacterSelect-termkit.ts
- src/tui/screens/ForestIntro-termkit.ts
- src/tui/scene.ts
