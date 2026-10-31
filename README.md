# plain-summary

A Claude Code mod that adds a **Plain summary** pane beside the chat. It explains what Claude does in ASD-STE100 Simplified Technical English, without putting that instruction into Claude's own context.

- **One fold per thing you did:** each message you send, shell command you run, or side task you start begins a fold. The fold holds everything Claude did until your next one. Notifications and system messages never start a fold.
- **Folded, a fold is two lines:** your words, then "→ outcome" in one short line that says plainly when something failed or is not done. The newest fold is open; the rest stay folded until you open them (or "Open all").
- **Open, it shows detail one level at a time:** Claude's tool calls grouped by purpose (a blocked or failed group opens itself and says why), each step with "Show command", Claude's reply in 1 to 3 short lines, and "Show full reply" for the original text.
- Summaries are written by Haiku once Claude's turn ends: one call per fold, kept out of the main conversation. A prompt rule keeps warnings and instructions to you meaning exactly what Claude said. A quick chat answer needs no model call.
- `/plain` opens the pane; `/plain model haiku|sonnet|opus` sets the summary model; `/plain now` re-summarises the newest fold.
- History is kept per session in the mod's local store (the 20 most recent sessions), so it survives an app restart.

## Install

At the prompt of a terminal session:

```
/plugin install plain-summary --marketplace jamesbarker185/claude-mods
```

From a shell:

```bash
claude plugin install plain-summary --marketplace jamesbarker185/claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `jamesbarker185/claude-mods`, then Add plugin.

## Where it works

Plain summary works in local sessions: `claude` in a terminal, the Code tab of the Claude Desktop app, and the VS Code extension.

It doesn't work in cloud sessions (claude.ai/code, the mobile app, or a cloud session started from the Desktop app). A cloud session doesn't install plugins that a repository turns on in `.claude/settings.json`, and it doesn't show what a mod draws, such as this pane. See [Where mods run](https://code.claude.com/docs/en/plugins/mods/overview#where-mods-run) and [What carries over](https://code.claude.com/docs/en/cloud-environments). To use the pane on a repository, open a local session on it.

# ste-summary

A Claude Code mod that adds a one-line summary under each of Claude's replies, written in ASD-STE100 Simplified Technical English. The summary covers your latest prompt and Claude's answer to it. It is not added to Claude's context.

- Sonnet writes the summary when Claude's turn ends (one call per reply). Subagent turns, interrupted turns and refusals get no summary.
- The summary shows as one line of plain text that starts with `STE:`. Line breaks and Markdown are removed, because the chat draws this line as plain text.
- `/ste off` and `/ste on` turn the summaries off and on (kept across sessions); `/ste now` summarizes the latest exchange at once; `/ste` says whether it is on.
- The `model` option sets the summary model (default `sonnet`).

## Install

```bash
claude plugin install ste-summary --marketplace jamesbarker185/claude-mods
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `jamesbarker185/claude-mods`, then Add plugin. Like plain-summary, it works in local sessions only.
