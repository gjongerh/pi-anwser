import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Editor, type EditorTheme, type KeyId, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";

const isKey = (data: string, key: string): boolean => matchesKey(data, key as KeyId);

// ─── TYPES ───────────────────────────────────────────────────────────────────

type QuestionType = "open" | "yesNo" | "singleChoice" | "multipleChoice";

/** Condition for showing a question only when a prior answer matches. */
type ShowIfCondition = {
	/** ID of the question this depends on. */
	id: string;
	/** Expected answer. Array means "any of these values". */
	answer: string | boolean | string[];
};

type Question = {
	id: string;
	type: QuestionType;
	label: string;
	description?: string;
	required?: boolean;
	options?: string[];
	defaultValue?: string | string[] | boolean;
	soft?: boolean;
	/** Feature 1: Only show this question when a prior answer matches. */
	showIf?: ShowIfCondition;
};

type Answer = {
	id: string;
	question: string;
	type: QuestionType;
	answer: string | string[] | boolean | null;
	skipped: boolean;
};

type PiAnwserConfig = {
	enabled: boolean;
	trigger: { automaticDetection: boolean; structuredTool: boolean; runOn: "message_end" | "agent_end"; maxQuestions: number; ignoreSoftEndingsUnlessOtherQuestionsExist: boolean };
	detection: { openQuestions: boolean; yesNoQuestions: boolean; singleChoice: boolean; multipleChoice: boolean; markdownCheckboxes: boolean; numberedOptions: boolean; letteredOptions: boolean; softEndingPatterns: string[]; ignoredPatterns: string[]; ignoreCodeBlocks: boolean };
	popup: { placement: "right"; width: "30%" | "40%" | "50%" | number; oneQuestionAtATime: boolean; showProgress: boolean; allowSkip: boolean; allowBack: boolean; allowCancel: boolean };
	openQuestion: { inputMode: "multiline-editor"; required: boolean; placeholder: string };
	choiceQuestion: { allowMultiple: boolean; allowOther: boolean; required: boolean };
	review: { enabled: boolean; editorTitle: string; askConfirmationBeforeSend: boolean; sendTemplate: string };
	shortcuts: { toggleOverlay: string; nextQuestion: string; previousQuestion: string; submitQuestion: string; skipQuestion: string; cancel: string };
	persistence: { saveLastQuestions: boolean; saveAnswersInSession: boolean };
};

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: PiAnwserConfig = {
	enabled: true,
	trigger: { automaticDetection: true, structuredTool: true, runOn: "message_end", maxQuestions: 10, ignoreSoftEndingsUnlessOtherQuestionsExist: true },
	detection: {
		openQuestions: true,
		yesNoQuestions: true,
		singleChoice: true,
		multipleChoice: true,
		markdownCheckboxes: true,
		numberedOptions: true,
		letteredOptions: true,
		softEndingPatterns: ["let me know if", "tell me if", "would you like me to", "do you want me to", "should i continue"],
		ignoredPatterns: [],
		ignoreCodeBlocks: true,
	},
	popup: { placement: "right", width: "40%", oneQuestionAtATime: true, showProgress: true, allowSkip: true, allowBack: true, allowCancel: true },
	openQuestion: { inputMode: "multiline-editor", required: false, placeholder: "Type your answer..." },
	choiceQuestion: { allowMultiple: true, allowOther: true, required: false },
	review: { enabled: true, editorTitle: "Review answers before sending", askConfirmationBeforeSend: true, sendTemplate: "Answers to your questions:\n\n{{answers}}" },
	shortcuts: { toggleOverlay: "ctrl+shift+a", nextQuestion: "alt+right", previousQuestion: "alt+left", submitQuestion: "ctrl+enter", skipQuestion: "ctrl+shift+s", cancel: "escape" },
	persistence: { saveLastQuestions: true, saveAnswersInSession: true },
};

// ─── SCHEMA ──────────────────────────────────────────────────────────────────

const ShowIfSchema = Type.Object({
	id: Type.String({ description: "ID of the question this depends on" }),
	answer: Type.Union([Type.String(), Type.Boolean(), Type.Array(Type.String())], {
		description: "Expected answer value. Use an array to match any of multiple values.",
	}),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable identifier for the question" }),
	type: StringEnum(["open", "yesNo", "singleChoice", "multipleChoice"] as const),
	label: Type.String({ description: "Question text shown to the user" }),
	description: Type.Optional(Type.String({ description: "Optional additional context" })),
	required: Type.Optional(Type.Boolean({ description: "Whether an answer is required" })),
	options: Type.Optional(Type.Array(Type.String(), { description: "Choices for singleChoice/multipleChoice questions" })),
	defaultValue: Type.Optional(Type.Any()),
	showIf: Type.Optional(ShowIfSchema),
});

const AskUserQuestionsParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
	reason: Type.Optional(Type.String({ description: "Why these answers are needed" })),
	sendAfterAnswer: Type.Optional(
		Type.Boolean({
			description:
				"When true, answers are returned immediately as structured JSON tool result without a review step. Use for agentic flows where the LLM reads answers programmatically. When false (default), the user reviews answers in an editor before they are sent back as a user message.",
		}),
	),
});

type AskUserQuestionsParams = Static<typeof AskUserQuestionsParams>;

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeDeep<T>(base: T, patch: unknown): T {
	if (!isRecord(base) || !isRecord(patch)) return (patch === undefined ? base : patch) as T;
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) out[key] = key in out ? mergeDeep(out[key], value) : value;
	return out as T;
}

async function readJson(path: string): Promise<unknown | undefined> {
	if (!existsSync(path)) return undefined;
	return JSON.parse(await readFile(path, "utf8"));
}

async function loadConfig(cwd: string): Promise<PiAnwserConfig> {
	let config = DEFAULT_CONFIG;
	const globalConfig = await readJson(join(homedir(), ".pi", "agent", "pi-anwser.json"));
	if (globalConfig) config = mergeDeep(config, globalConfig);
	const projectConfig = await readJson(join(cwd, ".pi", "pi-anwser.json"));
	if (projectConfig) config = mergeDeep(config, projectConfig);
	return config;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item: any) => (item?.type === "text" ? item.text : ""))
		.filter(Boolean)
		.join("\n");
}

function stripCodeBlocks(text: string): string {
	return text.replace(/```[\s\S]*?```/g, "");
}

function normalizedId(text: string, index: number): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 36);
	return slug || `question-${index + 1}`;
}

/** Feature 8: Normalise a question label for deduplication comparison. */
function normaliseLabel(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function isIgnored(text: string, config: PiAnwserConfig): boolean {
	const lower = text.toLowerCase();
	return config.detection.ignoredPatterns.some((p) => p && lower.includes(p.toLowerCase()));
}

function isSoftEnding(line: string, config: PiAnwserConfig): boolean {
	const lower = line.toLowerCase();
	return config.detection.softEndingPatterns.some((p) => lower.includes(p));
}

function optionFromLine(line: string, config: PiAnwserConfig): { option: string; checkbox: boolean } | undefined {
	let m: RegExpMatchArray | null;
	if (config.detection.markdownCheckboxes && (m = line.match(/^\s*[-*]\s+\[(?: |x|X)\]\s+(.+)$/))) return { option: m[1]!.trim(), checkbox: true };
	if ((m = line.match(/^\s*[-*]\s+(.+)$/))) return { option: m[1]!.trim(), checkbox: false };
	if (config.detection.numberedOptions && (m = line.match(/^\s*\d+[.)]\s+(.+)$/))) return { option: m[1]!.trim(), checkbox: false };
	if (config.detection.letteredOptions && (m = line.match(/^\s*[A-Z][.)]\s+(.+)$/i))) return { option: m[1]!.trim(), checkbox: false };
	return undefined;
}

function classifyQuestion(label: string, options: string[], sawCheckbox: boolean): QuestionType {
	if (options.length > 0) {
		if (sawCheckbox || /select all|choose all|multiple|which of the following/i.test(label)) return "multipleChoice";
		return "singleChoice";
	}
	if (/^(do|does|did|should|could|can|would|will|is|are|am|was|were|have|has)\b/i.test(label)) return "yesNo";
	return "open";
}

function detectQuestions(text: string, config: PiAnwserConfig): Question[] {
	const source = config.detection.ignoreCodeBlocks ? stripCodeBlocks(text) : text;
	const lines = source.split(/\r?\n/);
	const questions: Question[] = [];
	const soft: Question[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trim();
		if (!line || isIgnored(line, config)) continue;

		const lineIsSoft = isSoftEnding(line, config);
		const questionLike = /\?\s*$/.test(line) || lineIsSoft;
		if (!questionLike) continue;

		const options: string[] = [];
		let sawCheckbox = false;
		for (let j = i + 1; j < Math.min(lines.length, i + 9); j++) {
			const next = lines[j]!.trim();
			if (!next) {
				if (options.length > 0) break;
				continue;
			}
			const opt = optionFromLine(next, config);
			if (!opt) break;
			options.push(opt.option);
			sawCheckbox ||= opt.checkbox;
		}

		const type = classifyQuestion(line, options, sawCheckbox);
		if (type === "open" && !config.detection.openQuestions) continue;
		if (type === "yesNo" && !config.detection.yesNoQuestions) continue;
		if (type === "singleChoice" && !config.detection.singleChoice) continue;
		if (type === "multipleChoice" && !config.detection.multipleChoice) continue;

		const q: Question = { id: normalizedId(line, questions.length + soft.length), label: line, type, options, required: false, soft: lineIsSoft };
		if (lineIsSoft) soft.push(q);
		else questions.push(q);
	}

	if (!config.trigger.ignoreSoftEndingsUnlessOtherQuestionsExist || questions.length > 0) questions.push(...soft);
	return questions.slice(0, config.trigger.maxQuestions);
}

/** Feature 1: Evaluate a showIf condition against current answers. */
function shouldShow(question: Question, answers: Answer[]): boolean {
	if (!question.showIf) return true;
	const { id, answer: expected } = question.showIf;
	const found = answers.find((a) => a.id === id);
	if (!found || found.skipped) return false;
	const actual = found.answer;
	if (Array.isArray(expected)) {
		if (Array.isArray(actual)) return expected.some((e) => (actual as string[]).includes(e));
		return expected.includes(actual as string);
	}
	return actual === expected;
}

/** Feature 8: Remove questions already answered in this session. */
function deduplicateQuestions(questions: Question[], sessionAnswerSets: Answer[][]): Question[] {
	const answeredNorm = new Set(
		sessionAnswerSets.flatMap((set) =>
			set.filter((a) => !a.skipped && a.answer !== null).map((a) => normaliseLabel(a.question)),
		),
	);
	return questions.filter((q) => !answeredNorm.has(normaliseLabel(q.label)));
}

// ─── FORMAT ──────────────────────────────────────────────────────────────────

function answerToLines(answer: Answer): string[] {
	if (answer.skipped) return [`- ${answer.question}`, "  Answer: skipped"];
	const value = Array.isArray(answer.answer) ? answer.answer.join(", ") : String(answer.answer ?? "");
	return [`- ${answer.question}`, `  Answer: ${value}`];
}

function formatAnswers(answers: Answer[], config: PiAnwserConfig): string {
	const body = answers.flatMap(answerToLines).join("\n");
	return config.review.sendTemplate.replace("{{answers}}", body);
}

// ─── QUESTION OVERLAY ────────────────────────────────────────────────────────

/**
 * The main question-answering popup overlay.
 *
 * Improvements vs original:
 *   Feature 1  – Conditional showIf branching (skips hidden questions)
 *   Feature 2  – Required indicator (* next to label)
 *   Feature 3  – Live character count for open questions
 *   Feature 4  – Per-question-type keyboard hints in footer
 *   Feature 6  – "Other" option uses a real Editor (no more char-by-char hack)
 */
class QuestionOverlay {
	private index = 0;
	private answers: Answer[];
	private selectedOption = 0;
	private otherText = "";
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly editor: Editor;
	private readonly otherEditor: Editor; // Feature 6

	constructor(
		private readonly tui: any,
		private readonly theme: Theme,
		private readonly config: PiAnwserConfig,
		private readonly questions: Question[],
		private readonly done: (answers: Answer[] | null) => void,
	) {
		this.answers = questions.map((q) => ({ id: q.id, question: q.label, type: q.type, answer: null, skipped: false }));

		const editorTheme: EditorTheme = {
			borderColor: (s: string) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			},
		};

		this.editor = new Editor(tui, editorTheme);
		this.editor.onSubmit = () => this.saveAndNext();

		// Feature 6: dedicated editor for the "Other" free-text field
		this.otherEditor = new Editor(tui, editorTheme);
		this.otherEditor.onSubmit = () => this.saveAndNext();

		// Start at first visible question (respects showIf at load time)
		const visible = this.visibleIndices();
		this.index = visible[0] ?? 0;
		this.editor.setText(String(questions[this.index]?.defaultValue ?? ""));
	}

	// ── Visible question helpers (Feature 1) ──────────────────────────────────

	private visibleIndices(): number[] {
		return this.questions.map((q, i) => ({ q, i })).filter(({ q }) => shouldShow(q, this.answers)).map(({ i }) => i);
	}

	private visiblePosition(): { pos: number; total: number } {
		const visible = this.visibleIndices();
		return { pos: visible.indexOf(this.index), total: visible.length };
	}

	// ── Navigation ────────────────────────────────────────────────────────────

	private current(): Question {
		return this.questions[this.index]!;
	}

	private resetPerQuestionInput() {
		const q = this.current();
		const existing = this.answers[this.index]?.answer;
		if (q.type === "open") {
			this.editor.setText(typeof existing === "string" ? existing : String(q.defaultValue ?? ""));
		} else {
			// Feature 6: reset the other editor too
			this.otherEditor.setText("");
			this.otherText = "";
			this.selectedOption = 0;
		}
	}

	private saveCurrent(skipped = false): boolean {
		const q = this.current();
		let answer: Answer["answer"] = null;

		if (skipped) {
			this.answers[this.index] = { id: q.id, question: q.label, type: q.type, answer: null, skipped: true };
			return true;
		}

		if (q.type === "open") {
			answer = this.editor.getText?.().trim?.() ?? "";
		} else if (q.type === "yesNo") {
			answer = this.selectedOption === 0;
		} else {
			const options = [...(q.options ?? [])];
			if (this.config.choiceQuestion.allowOther) options.push("Other");
			// Feature 6: read other text from the dedicated editor
			const otherText = this.otherEditor.getText?.()?.trim?.() ?? this.otherText;
			const previous = this.answers[this.index]?.answer;

			if (q.type === "multipleChoice") {
				answer = Array.isArray(previous) ? previous : [];
				if (otherText) answer = [...(answer as string[]).filter((x) => x !== "Other"), otherText];
			} else {
				const selected = options[this.selectedOption] ?? options[0] ?? "";
				answer = selected === "Other" && otherText ? otherText : selected;
			}
		}

		if ((q.required ?? false) && (answer === null || answer === "" || (Array.isArray(answer) && answer.length === 0))) return false;
		this.answers[this.index] = { id: q.id, question: q.label, type: q.type, answer, skipped: false };
		return true;
	}

	private saveAndNext() {
		if (!this.saveCurrent(false)) return;
		this.goNextOrDone();
	}

	private skipAndNext() {
		this.saveCurrent(true);
		this.goNextOrDone();
	}

	private goNextOrDone() {
		const visible = this.visibleIndices();
		const pos = visible.indexOf(this.index);
		if (pos < visible.length - 1) {
			this.index = visible[pos + 1]!;
			this.resetPerQuestionInput();
			this.invalidate();
			this.tui.requestRender();
		} else {
			this.done(this.answers);
		}
	}

	private previous() {
		this.saveCurrent(false);
		const visible = this.visibleIndices();
		const pos = visible.indexOf(this.index);
		if (pos > 0) {
			this.index = visible[pos - 1]!;
			this.resetPerQuestionInput();
			this.invalidate();
			this.tui.requestRender();
		}
	}

	private toggleChoice() {
		const q = this.current();
		if (q.type !== "multipleChoice") return;
		const opts = q.options ?? [];
		const selected = opts[this.selectedOption];
		if (!selected) return;
		const current = this.answers[this.index]?.answer;
		const values = Array.isArray(current) ? [...current] : [];
		const pos = values.indexOf(selected);
		if (pos >= 0) values.splice(pos, 1);
		else values.push(selected);
		this.answers[this.index] = { id: q.id, question: q.label, type: q.type, answer: values, skipped: false };
	}

	// ── Input handling ────────────────────────────────────────────────────────

	handleInput(data: string): void {
		// Global overlay shortcuts always take priority
		if (isKey(data, this.config.shortcuts.cancel) || isKey(data, "escape")) {
			this.done(null);
			return;
		}
		if (isKey(data, this.config.shortcuts.previousQuestion) || isKey(data, "alt+left")) {
			this.previous();
			return;
		}
		if (isKey(data, this.config.shortcuts.nextQuestion) || isKey(data, "alt+right") || isKey(data, this.config.shortcuts.submitQuestion)) {
			this.saveAndNext();
			return;
		}
		if (isKey(data, this.config.shortcuts.skipQuestion)) {
			this.skipAndNext();
			return;
		}

		const q = this.current();

		if (q.type === "open") {
			this.editor.handleInput(data);
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// Feature 4: Y/N shortcut for yesNo questions
		if (q.type === "yesNo") {
			if (data.toLowerCase() === "y") {
				this.selectedOption = 0;
				this.saveAndNext();
				return;
			}
			if (data.toLowerCase() === "n") {
				this.selectedOption = 1;
				this.saveAndNext();
				return;
			}
		}

		if (isKey(data, "up")) {
			this.selectedOption = Math.max(0, this.selectedOption - 1);
		} else if (isKey(data, "down")) {
			const count = q.type === "yesNo" ? 2 : (q.options?.length ?? 0) + (this.config.choiceQuestion.allowOther ? 1 : 0);
			this.selectedOption = Math.min(Math.max(0, count - 1), this.selectedOption + 1);
		} else if (isKey(data, "space")) {
			// Space: toggle for multipleChoice, select for single/yesNo
			if (q.type === "multipleChoice") this.toggleChoice();
			else this.saveAndNext();
		} else if (isKey(data, "return") || isKey(data, "enter")) {
			// Enter always advances
			this.saveAndNext();
		} else {
			// Feature 6: route remaining input to the otherEditor when "Other" is selected
			const opts =
				q.type === "yesNo"
					? ["Yes", "No"]
					: [...(q.options ?? []), ...(this.config.choiceQuestion.allowOther ? ["Other"] : [])];
			const isOtherSelected = this.config.choiceQuestion.allowOther && q.type !== "yesNo" && this.selectedOption === opts.length - 1;
			if (isOtherSelected) {
				this.otherEditor.handleInput(data);
				this.otherText = this.otherEditor.getText?.()?.trim?.() ?? "";
				this.invalidate();
				this.tui.requestRender();
				return;
			}
		}

		this.invalidate();
		this.tui.requestRender();
	}

	// ── Rendering ─────────────────────────────────────────────────────────────

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const q = this.current();
		const innerW = Math.max(30, width - 2);
		const pad = (s: string) => s + " ".repeat(Math.max(0, innerW - visibleWidth(s)));
		const row = (s: string) => th.fg("border", "│") + pad(truncateToWidth(s, innerW)) + th.fg("border", "│");

		const { pos, total } = this.visiblePosition();
		const lines: string[] = [];

		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(
			row(` ${th.fg("accent", th.bold("Answer questions"))} ${th.fg("dim", `${pos + 1}/${total}`)}`),
		);

		// Feature 2: required indicator
		const reqSuffix = q.required ? th.fg("error", " *") : "";
		lines.push(row(` ${th.fg("text", q.label)}${reqSuffix}`));
		if (q.description) lines.push(row(` ${th.fg("muted", q.description)}`));
		lines.push(row(""));

		if (q.type === "open") {
			// Feature 3: character count
			const charCount = (this.editor.getText?.() ?? "").length;
			lines.push(row(` ${th.fg("dim", this.config.openQuestion.placeholder)}  ${th.fg("dim", `${charCount} chars`)}`));
			for (const line of this.editor.render(Math.max(10, innerW - 2))) lines.push(row(` ${line}`));
		} else {
			const opts =
				q.type === "yesNo"
					? ["Yes", "No"]
					: [...(q.options ?? []), ...(this.config.choiceQuestion.allowOther ? ["Other"] : [])];
			const current = this.answers[this.index]?.answer;

			for (let i = 0; i < opts.length; i++) {
				const selected = i === this.selectedOption;
				const checked = q.type === "multipleChoice" && Array.isArray(current) && current.includes(opts[i]!);
				const marker = q.type === "multipleChoice" ? (checked ? "[x]" : "[ ]") : selected ? "●" : "○";

				// Feature 6: when "Other" is selected, embed the otherEditor
				if (opts[i] === "Other" && selected) {
					lines.push(row(` ${th.fg("accent", ">")} ${marker} ${th.fg("accent", "Other:")}`));
					for (const eline of this.otherEditor.render(Math.max(10, innerW - 6))) {
						lines.push(row(`     ${eline}`));
					}
				} else {
					const label = opts[i]!;
					lines.push(row(` ${selected ? th.fg("accent", ">") : " "} ${marker} ${selected ? th.fg("accent", label) : label}`));
				}
			}
		}

		lines.push(row(""));

		// Feature 4: per-type keyboard hints
		const hint =
			q.type === "open"
				? "Ctrl+Enter next  ·  Esc cancel"
				: q.type === "yesNo"
					? "Y yes  ·  N no  ·  ↑↓ navigate  ·  Enter confirm  ·  Esc cancel"
					: q.type === "multipleChoice"
						? "↑↓ navigate  ·  Space toggle  ·  Enter next  ·  Esc cancel"
						: "↑↓ navigate  ·  Enter select  ·  Esc cancel";
		lines.push(row(` ${th.fg("dim", hint)}`));
		if (this.config.popup.allowBack && pos > 0) {
			lines.push(row(` ${th.fg("dim", `Alt+← back  ·  Alt+→ next  ·  Ctrl+Shift+S skip`)}`));
		}
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.editor.invalidate?.();
		this.otherEditor.invalidate?.();
	}
}

// ─── REVIEW OVERLAY ──────────────────────────────────────────────────────────

/**
 * Feature 7: Structured review panel shown before sending answers.
 * Renders all Q→A pairs and offers Edit / Send ✓ / Cancel actions.
 * The user picks an action with ←→ and confirms with Enter.
 */
class ReviewOverlay {
	private action: "edit" | "send" | "cancel" = "send";
	private scrollOffset = 0;
	private contentLines: string[] = []; // computed in render, used for scroll bounds
	private cachedWidth?: number;
	private cachedLines?: string[];

	private static readonly MAX_VISIBLE_CONTENT = 14;

	constructor(
		private readonly tui: any,
		private readonly theme: Theme,
		private readonly answers: Answer[],
		private readonly done: (action: "edit" | "send" | "cancel") => void,
	) {}

	handleInput(data: string): void {
		if (isKey(data, "escape")) {
			this.done("cancel");
			return;
		}
		if (isKey(data, "left") || isKey(data, "shift+tab")) {
			this.action = this.action === "cancel" ? "send" : "edit";
		} else if (isKey(data, "right") || isKey(data, "tab")) {
			this.action = this.action === "edit" ? "send" : "cancel";
		} else if (isKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (isKey(data, "down")) {
			const maxScroll = Math.max(0, this.contentLines.length - ReviewOverlay.MAX_VISIBLE_CONTENT);
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
		} else if (isKey(data, "return") || isKey(data, "enter")) {
			this.done(this.action);
			return;
		}
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const innerW = Math.max(30, width - 2);
		const pad = (s: string) => s + " ".repeat(Math.max(0, innerW - visibleWidth(s)));
		const row = (s: string) => th.fg("border", "│") + pad(truncateToWidth(s, innerW)) + th.fg("border", "│");

		// Build content lines (all Q→A pairs)
		this.contentLines = [];
		for (const answer of this.answers) {
			this.contentLines.push(` ${th.fg("dim", "Q:")} ${th.fg("text", answer.question)}`);
			const val = answer.skipped
				? th.fg("muted", "skipped")
				: answer.answer === true
					? th.fg("success", "Yes")
					: answer.answer === false
						? th.fg("warning", "No")
						: Array.isArray(answer.answer)
							? th.fg("accent", answer.answer.join(", "))
							: th.fg("text", String(answer.answer ?? ""));
			this.contentLines.push(` ${th.fg("dim", "A:")} ${val}`);
			this.contentLines.push("");
		}

		const maxScroll = Math.max(0, this.contentLines.length - ReviewOverlay.MAX_VISIBLE_CONTENT);
		this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
		const visible = this.contentLines.slice(this.scrollOffset, this.scrollOffset + ReviewOverlay.MAX_VISIBLE_CONTENT);

		const lines: string[] = [];
		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(row(` ${th.fg("accent", th.bold("Review answers"))} ${th.fg("dim", `${this.answers.length} question(s)`)}`));
		lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));

		for (const line of visible) lines.push(row(line));

		if (this.contentLines.length > ReviewOverlay.MAX_VISIBLE_CONTENT) {
			const pct = Math.round(((this.scrollOffset + ReviewOverlay.MAX_VISIBLE_CONTENT) / this.contentLines.length) * 100);
			lines.push(row(` ${th.fg("dim", `↑↓ scroll  ${pct}%`)}`));
		}

		lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));

		// Action bar
		const labels = { edit: "Edit text", send: "Send ✓", cancel: "Cancel" } as const;
		const actions = (["edit", "send", "cancel"] as const)
			.map((a) => (a === this.action ? th.fg("accent", th.bold(`[${labels[a]}]`)) : th.fg("muted", `[${labels[a]}]`)))
			.join("  ");
		lines.push(row(` ${actions}`));
		lines.push(row(` ${th.fg("dim", "←→ / Tab select  ·  Enter confirm  ·  Esc cancel")}`));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ─── HISTORY OVERLAY ─────────────────────────────────────────────────────────

/**
 * Feature 5: Scrollable history of all answer sessions from this session.
 * Navigate with ↑↓, expand/collapse with Enter, close with Esc.
 */
class HistoryOverlay {
	private selected = 0;
	private expanded: number | null = null;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly tui: any,
		private readonly theme: Theme,
		private readonly sessions: Array<{ timestamp: number; answers: Answer[] }>,
		private readonly done: () => void,
	) {}

	handleInput(data: string): void {
		if (isKey(data, "escape")) {
			this.done();
			return;
		}
		if (isKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
		else if (isKey(data, "down")) this.selected = Math.min(this.sessions.length - 1, this.selected + 1);
		else if (isKey(data, "return") || isKey(data, "enter")) {
			this.expanded = this.expanded === this.selected ? null : this.selected;
		}
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const innerW = Math.max(30, width - 2);
		const pad = (s: string) => s + " ".repeat(Math.max(0, innerW - visibleWidth(s)));
		const row = (s: string) => th.fg("border", "│") + pad(truncateToWidth(s, innerW)) + th.fg("border", "│");

		const lines: string[] = [];
		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(row(` ${th.fg("accent", th.bold("Answer History"))} ${th.fg("dim", `${this.sessions.length} session(s)`)}`));
		lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));

		if (this.sessions.length === 0) {
			lines.push(row(` ${th.fg("muted", "No answer history in this session")}`));
		} else {
			for (let i = 0; i < this.sessions.length; i++) {
				const session = this.sessions[i]!;
				const isSelected = i === this.selected;
				const isExpanded = i === this.expanded;
				const time = new Date(session.timestamp).toLocaleTimeString();
				const prefix = isSelected ? th.fg("accent", ">") : " ";
				const toggle = isExpanded ? "▼" : "▶";
				const entryLabel = `${time} — ${session.answers.length} answer(s)`;

				lines.push(row(` ${prefix} ${toggle} ${isSelected ? th.fg("accent", entryLabel) : entryLabel}`));

				if (isExpanded) {
					for (const answer of session.answers) {
						lines.push(row(`     ${th.fg("dim", "Q:")} ${th.fg("muted", truncateToWidth(answer.question, innerW - 12))}`));
						const val = answer.skipped
							? th.fg("dim", "skipped")
							: answer.answer === true
								? "Yes"
								: answer.answer === false
									? "No"
									: Array.isArray(answer.answer)
										? answer.answer.join(", ")
										: String(answer.answer ?? "");
						lines.push(row(`     ${th.fg("dim", "A:")} ${truncateToWidth(val, innerW - 12)}`));
					}
					lines.push(row(""));
				}
			}
		}

		lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));
		lines.push(row(` ${th.fg("dim", "↑↓ navigate  ·  Enter expand/collapse  ·  Esc close")}`));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ─── TOOL SCHEMA ─────────────────────────────────────────────────────────────

export default function piAnwser(pi: ExtensionAPI) {
	let config: PiAnwserConfig = DEFAULT_CONFIG;
	let lastQuestions: Question[] = [];
	let lastAnswers: Answer[] = [];
	let pendingQuestions: Question[] = []; // Feature 9: deferred widget questions
	let popupOpen = false;

	// ── Core ask function ─────────────────────────────────────────────────────

	async function askQuestions(ctx: ExtensionContext, questions: Question[]): Promise<Answer[] | null> {
		if (!ctx.hasUI || !config.enabled || questions.length === 0) return null;
		popupOpen = true;
		// Feature 9: clear widget when popup opens
		pendingQuestions = [];
		ctx.ui.setWidget("pi-anwser", []);
		try {
			const answers = await ctx.ui.custom<Answer[] | null>(
				(tui, theme, _kb, done) => new QuestionOverlay(tui, theme, config, questions, done),
				{ overlay: true, overlayOptions: { anchor: "right-center", width: config.popup.width, minWidth: 44, maxHeight: "90%", margin: 1 } },
			);
			if (!answers) return null;
			lastAnswers = answers;
			if (config.persistence.saveAnswersInSession) pi.appendEntry("pi-anwser.answers", { answers, timestamp: Date.now() });
			return answers;
		} finally {
			popupOpen = false;
		}
	}

	// ── Review and send ───────────────────────────────────────────────────────

	/**
	 * Feature 7: Show ReviewOverlay (structured Q→A panel) before sending.
	 *
	 * Flow when review.enabled = true:
	 *   ReviewOverlay → "Edit" → text editor (+ optional confirm) → send
	 *                 → "Send ✓"                                   → send
	 *                 → "Cancel"                                   → abort
	 *
	 * Flow when review.enabled = false:
	 *   optional confirm → send
	 */
	async function reviewAndSend(ctx: ExtensionContext, answers: Answer[], send: boolean): Promise<string | null> {
		let message = formatAnswers(answers, config);

		if (config.review.enabled) {
			const action = await ctx.ui.custom<"edit" | "send" | "cancel">(
				(tui, theme, _kb, done) => new ReviewOverlay(tui, theme, answers, done),
				{ overlay: true, overlayOptions: { anchor: "right-center", width: config.popup.width, minWidth: 44, maxHeight: "90%", margin: 1 } },
			);
			if (!action || action === "cancel") return null;

			if (action === "edit") {
				const reviewed = await ctx.ui.editor(config.review.editorTitle, message);
				if (reviewed === undefined) return null;
				message = reviewed;
				// Confirmation only applies after manual editing
				if (config.review.askConfirmationBeforeSend) {
					const ok = await ctx.ui.confirm("Send answers?", "Send the edited answers to the assistant?");
					if (!ok) return null;
				}
			}
			// "send" goes straight through — ReviewOverlay already acts as confirmation
		} else if (config.review.askConfirmationBeforeSend) {
			const ok = await ctx.ui.confirm("Send answers?", "Send these answers to the assistant?");
			if (!ok) return null;
		}

		if (send) {
			try {
				pi.sendUserMessage(message, { deliverAs: "followUp" } as any);
			} catch {
				pi.sendUserMessage(message);
			}
		}
		return message;
	}

	// ── Session answer history helper ─────────────────────────────────────────

	function getSessionAnswerSets(ctx: ExtensionContext): Answer[][] {
		return ctx.sessionManager
			.getEntries()
			.filter((e: any) => e.type === "custom" && e.customType === "pi-anwser.answers")
			.map((e: any) => (e.data?.answers as Answer[]) ?? []);
	}

	// ── Auto-detection ────────────────────────────────────────────────────────

	/**
	 * Feature 9: Instead of immediately opening the popup, show a non-intrusive
	 * widget above the editor and let the user decide when to engage.
	 * Feature 8: Skip questions already answered in this session.
	 */
	async function runAutomatic(ctx: ExtensionContext, text: string) {
		if (!config.enabled || !config.trigger.automaticDetection || popupOpen || !ctx.hasUI) return;

		const rawQuestions = detectQuestions(text, config);
		if (rawQuestions.length === 0) return;

		// Feature 8: deduplicate against session history
		const sessionAnswerSets = getSessionAnswerSets(ctx);
		const questions = deduplicateQuestions(rawQuestions, sessionAnswerSets);
		if (questions.length === 0) return;

		lastQuestions = questions;
		pendingQuestions = questions;
		if (config.persistence.saveLastQuestions) pi.appendEntry("pi-anwser.questions", { questions, timestamp: Date.now() });

		// Feature 9: show widget instead of blocking popup
		const n = questions.length;
		const shortcut = config.shortcuts.toggleOverlay;
		ctx.ui.setWidget("pi-anwser", [
			`${ctx.ui.theme.fg("accent", `💬 ${n} question${n !== 1 ? "s" : ""} detected`)}  ${ctx.ui.theme.fg("dim", `·  ${shortcut} to answer`)}`,
		]);
	}

	// ── Events ────────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		try {
			config = await loadConfig(ctx.cwd);
		} catch (error) {
			ctx.ui.notify(`pi-anwser config error: ${(error as Error).message}`, "error");
			config = DEFAULT_CONFIG;
		}
		ctx.ui.setStatus("pi-anwser", config.enabled ? ctx.ui.theme.fg("accent", "anwser:on") : ctx.ui.theme.fg("dim", "anwser:off"));
	});

	// Clear pending widget at the start of each agent turn
	pi.on("agent_start", async (_event, ctx) => {
		if (pendingQuestions.length > 0) {
			pendingQuestions = [];
			ctx.ui.setWidget("pi-anwser", []);
		}
	});

	pi.on("message_end", async (event: any, ctx) => {
		if (config.trigger.runOn !== "message_end") return;
		if (event.message?.role !== "assistant") return;
		await runAutomatic(ctx, contentText(event.message.content));
	});

	pi.on("agent_end", async (event: any, ctx) => {
		if (config.trigger.runOn !== "agent_end") return;
		const assistant = [...(event.messages ?? [])].reverse().find((m: any) => m.role === "assistant");
		if (assistant) await runAutomatic(ctx, contentText(assistant.content));
	});

	// ── Tool ──────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "ask_user_questions",
		label: "Ask User Questions",
		description:
			"Ask the user one or more questions in a right-side popup overlay. Use when progress depends on user input, preferences, missing requirements, or a choice among options.",
		promptSnippet: "Ask the user structured questions in a popup overlay and receive reviewed answers.",
		promptGuidelines: ["Use ask_user_questions when you need the user's answers before proceeding instead of burying multiple questions in prose."],
		parameters: AskUserQuestionsParams,

		async execute(_toolCallId: string, params: AskUserQuestionsParams, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext): Promise<any> {
			if (!config.trigger.structuredTool) {
				return { content: [{ type: "text", text: "pi-anwser structured tool is disabled." }], details: { answers: [] as Answer[] } };
			}

			const questions: Question[] = params.questions.map((q, i) => ({
				id: q.id || `question-${i + 1}`,
				type: q.type,
				label: q.label,
				description: q.description,
				required: q.required,
				options: q.options,
				defaultValue: q.defaultValue as any,
				showIf: q.showIf as ShowIfCondition | undefined,
			}));

			lastQuestions = questions;

			const answers = await askQuestions(ctx, questions);
			if (!answers) {
				return {
					content: [{ type: "text", text: "User cancelled the question overlay." }],
					details: { answers: [] as Answer[] },
				};
			}

			// Feature 10: sendAfterAnswer = true → skip review, return structured JSON immediately
			if (params.sendAfterAnswer) {
				const structured = {
					answers: answers.map((a) => ({
						id: a.id,
						question: a.question,
						type: a.type,
						answer: a.answer,
						skipped: a.skipped,
					})),
				};
				return {
					content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
					details: structured,
				};
			}

			// Default path: review then send as user message
			const reviewed = await reviewAndSend(ctx, answers, false);
			return {
				content: [{ type: "text", text: reviewed ?? formatAnswers(answers, config) }],
				details: { answers, reviewed },
			};
		},

		renderCall(args: any, theme: Theme) {
			const count = Array.isArray(args?.questions) ? args.questions.length : 0;
			return {
				render: (width: number) => [
					truncateToWidth(theme.fg("toolTitle", theme.bold("ask_user_questions ")) + theme.fg("muted", `${count} question(s)`), width),
				],
				invalidate() {},
			};
		},

		renderResult(result: any, _options: any, theme: Theme) {
			const answers = result?.details?.answers as Answer[] | undefined;
			const text = answers?.length ? theme.fg("success", `✓ answered ${answers.length} question(s)`) : theme.fg("warning", "No answers");
			return { render: (width: number) => [truncateToWidth(text, width)], invalidate() {} };
		},
	});

	// ── Command ───────────────────────────────────────────────────────────────

	pi.registerCommand("pi-anwser", {
		description: "Configure Pi Anwser: status, on, off, test, last, history, reload-config.",
		handler: async (args, ctx) => {
			const cmd = args.trim() || "status";

			if (cmd === "on") {
				config.enabled = true;
			} else if (cmd === "off") {
				config.enabled = false;
			} else if (cmd === "reload-config") {
				config = await loadConfig(ctx.cwd);
			} else if (cmd === "test") {
				const qs: Question[] = [
					{ id: "name", type: "open", label: "What should I call this feature?", required: false },
					{
						id: "opts",
						type: "multipleChoice",
						label: "Which outputs should be shown?",
						options: ["tools", "thinking", "bash"],
						required: false,
					},
					// Feature 1: conditional question shown only when name was provided
					{
						id: "confirm",
						type: "yesNo",
						label: "Does that name sound right to you?",
						required: false,
						showIf: { id: "name", answer: "" },
					},
				];
				const answers = await askQuestions(ctx, qs);
				if (answers) await reviewAndSend(ctx, answers, true);
				return;
			} else if (cmd === "last") {
				if (lastQuestions.length === 0) {
					ctx.ui.notify("No previous questions", "info");
				} else {
					const answers = await askQuestions(ctx, lastQuestions);
					if (answers) await reviewAndSend(ctx, answers, true);
				}
				return;
			} else if (cmd === "history") {
				// Feature 5: show answer history from session
				const entries = ctx.sessionManager
					.getEntries()
					.filter((e: any) => e.type === "custom" && e.customType === "pi-anwser.answers")
					.map((e: any) => ({
						timestamp: (e.data?.timestamp as number) ?? 0,
						answers: (e.data?.answers as Answer[]) ?? [],
					}));

				if (entries.length === 0) {
					ctx.ui.notify("No answer history in this session", "info");
					return;
				}

				await ctx.ui.custom<null>(
					(tui, theme, _kb, done) => new HistoryOverlay(tui, theme, entries, () => done(null)),
					{ overlay: true, overlayOptions: { anchor: "right-center", width: config.popup.width, minWidth: 44, maxHeight: "90%", margin: 1 } },
				);
				return;
			} else if (cmd !== "status") {
				ctx.ui.notify("Usage: /pi-anwser [status|on|off|test|last|history|reload-config]", "error");
				return;
			}

			ctx.ui.setStatus("pi-anwser", config.enabled ? ctx.ui.theme.fg("accent", "anwser:on") : ctx.ui.theme.fg("dim", "anwser:off"));
			ctx.ui.notify(
				`pi-anwser ${config.enabled ? "on" : "off"}; last questions=${lastQuestions.length}; last answers=${lastAnswers.length}; pending=${pendingQuestions.length}`,
				"info",
			);
		},
	});

	// ── Shortcut ──────────────────────────────────────────────────────────────

	/**
	 * Feature 9: When questions are pending (widget visible) this shortcut opens
	 * the popup immediately. Falls back to last questions when nothing is pending.
	 */
	pi.registerShortcut(DEFAULT_CONFIG.shortcuts.toggleOverlay as KeyId, {
		description: "Open pi-anwser for pending or last questions",
		handler: async (ctx) => {
			if (popupOpen) return;
			const questions = pendingQuestions.length > 0 ? pendingQuestions : lastQuestions;
			if (questions.length === 0) {
				ctx.ui.notify("pi-anwser: no pending questions", "info");
				return;
			}
			// Clear widget before showing popup
			pendingQuestions = [];
			ctx.ui.setWidget("pi-anwser", []);
			const answers = await askQuestions(ctx, questions);
			if (answers) await reviewAndSend(ctx, answers, true);
		},
	});
}
