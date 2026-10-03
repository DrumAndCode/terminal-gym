# Claude Gym

A Claude Code mod for a daily rep goal. Claude lifts the code, you lift the weight: when a turn runs long, that's your cue for a set.

## What it does

- **Tracker band** above the prompt: `💪 ▓▓▓▓▓▓░░░░ 60/100 pushups  🔥3d` with `[ +5 ] [ +10 ] [ +25 ]` buttons.
- **Long-turn nudges**: after 45s of Claude working, a toast and the spinner suggest a set.
- **Strict mode** (opt-in): long turns add rep debt; your next prompt waits until it's paid.
- **Scoreboard**: streak plus a 28-day grid.
- **Walkthrough**: three steps on first run to pick a program.

## Install

Requires Claude Code 2.1.288 or newer (mods are early access).

```sh
git clone https://github.com/DrumAndCode/terminal-gym.git ~/terminal-gym
```

Load it for one session:

```sh
claude --plugin-dir ~/terminal-gym
```

Or load it in every session by adding the folder to `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/terminal-gym" } }
```

Restart Claude Code (a new process, not a resumed chat), and the welcome band shows above your prompt.

## Commands

| Command | Does |
|---|---|
| `/fit` | today's progress |
| `/fit 20` | log 20 reps |
| `/fit set 80` | fix today's count |
| `/fit reset` | today back to 0 |
| `/fit swap [exercise]` | switch today's exercise (next in your program, or the one named) |
| `/fit rest` | rest day (breaks streak, clears debt) |
| `/fit score` | streak + grid |
| `/fit program` | pick your program |
| `/fit coach strict` / `/fit coach easy` | strict mode on / off |
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
