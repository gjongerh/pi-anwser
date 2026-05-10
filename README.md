# Pi Anwser

A Pi extension that asks the user questions in a right-side popup overlay instead of relying only on inline chat prompts.

## Features

- Automatically detects assistant questions and opens a popup for answers.
- Supports structured question asking through the `ask_user_questions` tool.
- Supports open text, yes/no, single choice, and multiple choice questions.
- Supports markdown checkbox, numbered, lettered, and bullet option lists.
- Lets the user review answers before sending them back to the assistant.
- Can reopen the last detected questions.

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
      "id": "notes",
      "type": "open",
      "label": "Any extra requirements?",
      "required": false
    }
  ],
  "reason": "Need implementation preferences before continuing"
}
```

## Commands

```text
/pi-anwser status
/pi-anwser on
/pi-anwser off
/pi-anwser test
/pi-anwser last
/pi-anwser reload-config
```

## Shortcuts

Default shortcuts:

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+A` | Reopen/toggle Pi Anwser for last questions |
| `Alt+Right` | Next question |
| `Alt+Left` | Previous question |
| `Ctrl+Enter` | Submit current answer / next |
| `Ctrl+Shift+S` | Skip question |
| `Esc` | Cancel popup |

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
