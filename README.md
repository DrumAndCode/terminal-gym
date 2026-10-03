# ❚█═TERMINAL-GYM═█❚

**Your agent put in the reps. You next.**

A Claude Code mod for a daily bodyweight rep goal. When Claude runs a long turn, that's your cue for a set.

## What it does

- **Tracker band** above the prompt: `💪 ▓▓▓▓▓▓░░░░ 60/100 pushups  log reps: [ +5 ] [ +10 ] [ +25 ]  🔥3d`, grey at 0 then red, yellow and green as you close in on the goal.
- **Long-turn nudges**: after 30s of Claude working, a toast and the spinner suggest a set.
- **Strict mode** (opt-in): long turns add rep debt; your next prompt waits until you pay. Logging any reps unlocks your next prompt, plus every prompt for 2 minutes after; whatever's left comes due then. A toast tells you when the break's over.
- **Scoreboard** (`/fit score`): a barbell, your streak and a 28-day grid.
- **Walkthrough**: three steps on first run to pick a program.

## Install

Requires Claude Code 2.1.288 or newer.

```sh
claude plugin marketplace add DrumAndCode/terminal-gym
claude plugin install terminal-gym@terminal-gym
```

Or from inside a session: `/plugin install terminal-gym --marketplace DrumAndCode/terminal-gym`.

Start a new session and the welcome band shows above your prompt. Update later with `claude plugin update terminal-gym@terminal-gym`.

To hack on it, clone the repo and load it for one session with `claude --plugin-dir ./terminal-gym`.

## Commands

| Command | Does |
|---|---|
| `/fit` | today's progress |
| `/fit 20` | log 20 reps |
| `/fit set 80` | fix today's count |
| `/fit reset` | today back to 0 |
| `/fit swap [exercise]` | switch today's exercise (next in your program, or the one named) |
| `/fit rest` | rest day (breaks streak, clears debt) |
| `/fit rest off` | undo today's rest day (or press **Train today** on the band) |
| `/fit score` | streak + grid |
| `/fit program` | pick your program |
| `/fit strict` / `/fit easy` | strict mode on / off |
| `/fit rules` | house rules |
| `/fit tour` | replay the welcome |
| `/fit hide` | close panels |

Settings live in `/config` under terminal-gym: nudges, strict mode, nudge delay, reps per nudge, spinner takeover, band.

## Privacy

The mod makes no network calls and adds no hidden context for the model. `/fit` replies appear in your conversation like any slash command's output, so Claude can see them. Everything else stays in `~/.claude/fitness`:

- `routine.json`: the plan per weekday (`{ "mon": { "exercise": "pushups", "goal": 100 } }`, optional `"unit": "s"`).
- `log/YYYY-MM-DD`: that day's count. `log/YYYY-MM-DD.skip` marks a rest day.
- `log/YYYY-MM-DD.swap`: that day's exercise after `/fit swap` (JSON plan, same shape as a routine day).

## Contributing

Issues and PRs welcome. Keep changes small and include a test.

```sh
claude --plugin-dir .          # load it for one session
claude plugin validate .
claude plugin test .
```

`claude plugin test` runs `tests/*.test.tsx` against the engine itself. Once the mod has loaded, `tsc -p .` type-checks it against the engine's types in `.claude-plugin/types/`.

Mods are early access; the API can change between Claude Code releases.

## License

MIT
