# The Arbiter

A hierarchical AI orchestration system that extends Claude's effective context through delegation. When tasks exceed what one session can hold, use the Arbiter to manage a chain of workers while keeping the vision intact.

![Arbiter Demo](.github/demo.gif)

## Install

```bash
npm i -g arbiter-ai
arbiter
```

Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) login (run `claude` once to authenticate).

Come with a requirements doc—a markdown file that fully describes what you want built. The more detail, the better.

## How It Works

```
You → Arbiter → Orchestrators → Subagents
```

**The Arbiter** holds your vision. It clarifies requirements, delegates work, and coordinates all handoffs. It never does work directly—it manages.

**Orchestrators** are summoned workers. They dialogue with the Arbiter before starting and after finishing. They work until context fills, then hand back to the Arbiter for the next worker.

**Subagents** do the actual file edits, searches, and commands.

The result: millions of effective context tokens. Many hours of work under one unbroken understanding.

## Conceits

1. **Conversational handoff beats preparation.** You can never fully brief someone upfront. The dialogue at transitions—onboarding and wrap-up—is where understanding actually transfers.

2. **Coherence beats compression.** Compacting is just lossy handoff to yourself. One context that never summarizes will outperform a larger context that forgets.

## Controls

Vim-like control modes.

| Mode | Key | Action |
|------|-----|--------|
| INSERT | Type | Enter text |
| INSERT | Enter | Send message |
| INSERT | Esc | Switch to NORMAL |
| NORMAL | i / Enter | Switch to INSERT |
| NORMAL | j / k | Scroll chat |
| NORMAL | g / G | Top / bottom |
| NORMAL | o | Toggle logbook |
| Any | Ctrl+C | Quit |

## CLI Options

```bash
arbiter                     # Start fresh
arbiter ./requirements.md   # Load requirements file
arbiter --resume            # Resume previous session (if <24h old)
```

## Troubleshooting

If the TUI gets into a funky state (frozen, weird rendering, unresponsive), you can often fix it by suspending and resuming:

1. Press `Ctrl+Z` to suspend
2. Type `fg` and press Enter to resume

This resets the terminal state and redraws everything. Similar to the fix for Claude Code terminal issues.

## Disclaimer

This software runs AI agents with unrestricted system access (`bypassPermissions`). It can read, write, and execute anything on your machine.

**Use only in environments where you accept full responsibility for any actions taken.**

Designed for development machines and controlled environments—not production servers with sensitive data.

## License

[FSL-1.1-MIT](LICENSE) — Free to use, modify, and share. Just don't use it to compete with Arbiter. Converts to MIT on 2027-01-21.

Copyright 2025 Lucian Hymer LLC
