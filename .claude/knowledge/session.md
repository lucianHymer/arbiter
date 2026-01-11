### [00:38] [workflow] Sound Integration Requirements for Arbiter TUI
**Details**: The project already has a /workspace/project/sounds/ directory with 8 WAV files: death.wav, footstep.wav, jump.wav, magic.wav, menu-left.wav, menu-right.wav, menu-select.wav, quick-notice.wav. Sound integration requires creating a sound.ts module following the tileset.ts pattern (load sounds from assets directory, cache them, provide playback functions). No audio dependencies exist in package.json - will need to add a package like 'play-sound', 'node-wav', or platform-specific audio libraries. Audio playback should be integrated into: (1) TitleScreen keyboard handler (line 136-146) - play sound on any key; (2) CharacterSelect keyboard navigation (lines 236-251) - menu-left/right sounds on arrow keys, menu-select on ENTER; (3) ForestIntro keyboard movement (lines 942-1017) - footstep sound on arrow key movement, death.wav on death, jump.wav on successful exit; (4) tui-termkit.ts addMessage() function (line 928-957) - play quick-notice.wav when messages are added; (5) Hop animation system (lines 1391-1447) - play jump.wav during hop animation frames; (6) Demon spawn sequence (lines 1557-1607) - play magic.wav when demons spawn or during startSummonSequence(); (7) Arbiter walk animation (lines 1509-1546) - play footstep.wav for each step during animateArbiterWalk().
**Files**: src/tui/tileset.ts, src/tui/tui-termkit.ts, src/tui/screens/TitleScreen-termkit.ts, src/tui/screens/CharacterSelect-termkit.ts, src/tui/screens/ForestIntro-termkit.ts, src/tui/scene.ts
---

### [14:24] [gotcha] Avoid TypeScript "as" casts and "any" types
**Details**: TypeScript `as` casts and `any` types bypass type checking and hide bugs. The SDK hooks didn't work because we returned `object` and cast with `as Options["hooks"]` - TypeScript couldn't verify the structure was wrong.

Instead of:
- `function foo(): object` → use actual return type
- `x as SomeType` → fix the actual types
- `any` → use `unknown` and narrow with type guards

The SDK's types are correct - when we lie to the compiler with `as`, it can't help us.
**Files**: src/arbiter.ts, src/orchestrator.ts, src/router.ts
---

