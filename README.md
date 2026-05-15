# Pi Anwser

A Pi extension that asks the user questions in a right-side popup overlay instead of relying only on inline chat prompts.

## Features

- Automatically detects assistant questions and opens a popup for answers.
- Supports structured question asking through the `ask_user_questions` tool.
- Supports open text, yes/no, single choice, and multiple choice questions.
- Supports markdown checkbox, numbered, lettered, and bullet option lists.
- **Conditional branching** — questions with `showIf` only appear when a prior answer matches.
- **Non-intrusive widget** — auto-detected questions show a footer widget instead of immediately hijacking focus; press `Ctrl+Shift+A` when ready.
- **Deduplication** — questions already answered in the current session are silently skipped.
- **Structured review panel** — answers are shown as a Q→A table before sending, with Edit / Send / Cancel actions.
- **Answer history** — browse all past answer sessions with `/pi-anwser history`.
- **Real editor for "Other"** — the free-text Other option uses a full editor (cursor, backspace, paste) instead of the old char-by-char workaround.
- **Per-type keyboard hints** — the footer shows relevant shortcuts for the current question type.
- **Required indicator** — required questions show a `*` marker next to their label.
- **Live character count** — open-text questions display a running character count.
- **`sendAfterAnswer`** — set to `true` to return structured JSON answers directly as the tool result, skipping the review step (useful for agentic flows).

## Tool

The extension registers this tool:

```text
ask_user_questions
```

Use it when progress depends on user input, preferences, missing requirements, or a choice among options.

Example payload:

```json
{
  "questions": [
    {
      "id": "language",
      "type": "singleChoice",
      "label": "Which language should I use?",
      "options": ["TypeScript", "Python", "Go"]
    },
    {
      "id": "framework",
      "type": "singleChoice",
      "label": "Which React framework?",
      "options": ["Next.js", "Remix", "Vite"],
      "showIf": { "id": "language", "answer": "TypeScript" }
    },
    {
      "id": "notes",
      "type": "open",
      "label": "Any extra requirements?",
      "required": false
    }
  ],
  "reason": "Need implementation preferences before continuing"
}
```

Set `"sendAfterAnswer": true` to return answers immediately as a structured JSON tool result without any review step — useful when the LLM needs to read answers programmatically in an agentic flow:

```json
{
  "questions": [...],
  "sendAfterAnswer": true
}
```

## Commands

```text
/pi-anwser status          Show enabled/disabled state and question counts
/pi-anwser on              Enable the extension
/pi-anwser off             Disable the extension
/pi-anwser test            Open a test overlay with sample questions (incl. a conditional one)
/pi-anwser last            Re-open the last set of questions
/pi-anwser history         Browse all answer sessions from the current session
/pi-anwser reload-config   Reload config from disk without restarting
```

## Shortcuts

Default shortcuts:

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+A` | Open pending questions (or last questions if none pending) |
| `Alt+Right` | Next question |
| `Alt+Left` | Previous question |
| `Ctrl+Enter` | Submit current answer / next |
| `Ctrl+Shift+S` | Skip question |
| `Esc` | Cancel popup |

### Inside the Review panel

| Shortcut | Action |
| --- | --- |
| `←` / `→` or `Tab` | Cycle between Edit / Send / Cancel |
| `Enter` | Confirm selected action |
| `↑` / `↓` | Scroll Q&A list |
| `Esc` | Cancel |

### Yes/No question shortcuts

| Key | Action |
| --- | --- |
| `Y` | Select Yes and advance |
| `N` | Select No and advance |

## Configuration

Configuration is loaded from:

1. Global: `~/.pi/agent/pi-anwser.json`
2. Project: `.pi/pi-anwser.json`

Project config overrides global config.

See `examples/pi-anwser.json` for a starter configuration.

Example:

```json
{
  "enabled": true,
  "trigger": {
    "automaticDetection": true,
    "structuredTool": true,
    "runOn": "message_end",
    "maxQuestions": 10
  },
  "popup": {
    "placement": "right",
    "width": "40%",
    "oneQuestionAtATime": true,
    "allowSkip": true,
    "allowBack": true,
    "allowCancel": true
  },
  "review": {
    "enabled": true,
    "askConfirmationBeforeSend": true
  }
}
```

## Installation

Install from GitHub:

```bash
pi install git:github.com/gjongerh/pi-anwser
```

For a one-off trial without writing settings:

```bash
pi -e git:github.com/gjongerh/pi-anwser
```

## Development

Install dependencies and run type checking from the repository root:

```bash
npm install
npm test
```

For local development from the parent `extensions/` workspace, the parent `Makefile` can run the same checks:

```bash
make test
```

Try the extension without installing it permanently:

```bash
pi -e ./src/index.ts
```

The Pi package manifest points at `src/index.ts`.
