import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Editor, type EditorTheme, type KeyId, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";

const isKey = (data: string, key: string): boolean => matchesKey(data, key as KeyId);

type QuestionType = "open" | "yesNo" | "singleChoice" | "multipleChoice";

type Question = {
	id: string;
	type: QuestionType;
	label: string;
	description?: string;
	required?: boolean;
	options?: string[];
	defaultValue?: string | string[] | boolean;
	soft?: boolean;
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

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable identifier for the question" }),
	type: StringEnum(["open", "yesNo", "singleChoice", "multipleChoice"] as const),
	label: Type.String({ description: "Question text shown to the user" }),
	description: Type.Optional(Type.String({ description: "Optional additional context" })),
	required: Type.Optional(Type.Boolean({ description: "Whether an answer is required" })),
	options: Type.Optional(Type.Array(Type.String(), { description: "Choices for singleChoice/multipleChoice questions" })),
	defaultValue: Type.Optional(Type.Any()),
});

const AskUserQuestionsParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
	reason: Type.Optional(Type.String({ description: "Why these answers are needed" })),
	sendAfterAnswer: Type.Optional(Type.Boolean({ description: "Reserved. Answers are returned as the tool result after review." })),
});

type AskUserQuestionsParams = Static<typeof AskUserQuestionsParams>;

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
	const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36);
	return slug || `question-${index + 1}`;
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
	const lower = label.toLowerCase();
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

		const isSoft = lineIsSoft;
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

		const q: Question = { id: normalizedId(line, questions.length + soft.length), label: line, type, options, required: false, soft: isSoft };
		if (isSoft) soft.push(q);
		else questions.push(q);
	}

	if (!config.trigger.ignoreSoftEndingsUnlessOtherQuestionsExist || questions.length > 0) questions.push(...soft);
	return questions.slice(0, config.trigger.maxQuestions);
}

function answerToLines(answer: Answer): string[] {
	if (answer.skipped) return [`- ${answer.question}`, "  Answer: skipped"];
	const value = Array.isArray(answer.answer) ? answer.answer.join(", ") : String(answer.answer ?? "");
	return [`- ${answer.question}`, `  Answer: ${value}`];
}

function formatAnswers(answers: Answer[], config: PiAnwserConfig): string {
	const body = answers.flatMap(answerToLines).join("\n");
	return config.review.sendTemplate.replace("{{answers}}", body);
}

class QuestionOverlay {
	private index = 0;
	private answers: Answer[];
	private selectedOption = 0;
	private otherText = "";
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly editor: Editor;

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
		this.editor.setText(String(questions[0]?.defaultValue ?? ""));
		this.editor.onSubmit = () => this.saveAndNext();
	}

	private current(): Question {
		return this.questions[this.index]!;
	}

	private resetPerQuestionInput() {
		const q = this.current();
		const existing = this.answers[this.index]?.answer;
		if (q.type === "open") this.editor.setText(typeof existing === "string" ? existing : String(q.defaultValue ?? ""));
		this.selectedOption = 0;
		this.otherText = "";
	}

	private saveCurrent(skipped = false): boolean {
		const q = this.current();
		let answer: Answer["answer"] = null;
		if (skipped) {
			this.answers[this.index] = { id: q.id, question: q.label, type: q.type, answer: null, skipped: true };
			return true;
		}
		if (q.type === "open") answer = this.editor.getText?.().trim?.() ?? "";
		else if (q.type === "yesNo") answer = this.selectedOption === 0;
		else {
			const options = [...(q.options ?? [])];
			if (this.config.choiceQuestion.allowOther) options.push("Other");
			const previous = this.answers[this.index]?.answer;
			if (q.type === "multipleChoice") {
				answer = Array.isArray(previous) ? previous : [];
				if (this.otherText.trim()) answer = [...answer.filter((x) => x !== "Other"), this.otherText.trim()];
			} else {
				const selected = options[this.selectedOption] ?? options[0] ?? "";
				answer = selected === "Other" && this.otherText.trim() ? this.otherText.trim() : selected;
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
		if (this.index >= this.questions.length - 1) {
			this.done(this.answers);
			return;
		}
		this.index++;
		this.resetPerQuestionInput();
		this.invalidate();
		this.tui.requestRender();
	}

	private previous() {
		this.saveCurrent(false);
		this.index = Math.max(0, this.index - 1);
		this.resetPerQuestionInput();
		this.invalidate();
		this.tui.requestRender();
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

	handleInput(data: string): void {
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
		if (isKey(data, "up")) this.selectedOption = Math.max(0, this.selectedOption - 1);
		else if (isKey(data, "down")) {
			const count = q.type === "yesNo" ? 2 : (q.options?.length ?? 0) + (this.config.choiceQuestion.allowOther ? 1 : 0);
			this.selectedOption = Math.min(Math.max(0, count - 1), this.selectedOption + 1);
		} else if (isKey(data, "space") || isKey(data, "return") || isKey(data, "enter")) {
			if (q.type === "multipleChoice") this.toggleChoice();
			else this.saveAndNext();
		} else if (this.config.choiceQuestion.allowOther && data.length === 1 && data.charCodeAt(0) >= 32) {
			const count = q.type === "yesNo" ? 2 : (q.options?.length ?? 0) + 1;
			if (this.selectedOption === count - 1 && q.type !== "yesNo") this.otherText += data;
		} else if (isKey(data, "backspace") && this.otherText.length > 0) {
			this.otherText = this.otherText.slice(0, -1);
		}
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const q = this.current();
		const innerW = Math.max(30, width - 2);
		const pad = (s: string) => s + " ".repeat(Math.max(0, innerW - visibleWidth(s)));
		const row = (s: string) => th.fg("border", "│") + pad(truncateToWidth(s, innerW)) + th.fg("border", "│");
		const lines: string[] = [];
		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(row(` ${th.fg("accent", th.bold("Answer questions"))} ${th.fg("dim", `${this.index + 1}/${this.questions.length}`)}`));
		lines.push(row(` ${th.fg("text", q.label)}`));
		if (q.description) lines.push(row(` ${th.fg("muted", q.description)}`));
		lines.push(row(""));

		if (q.type === "open") {
			lines.push(row(` ${th.fg("dim", this.config.openQuestion.placeholder)}`));
			for (const line of this.editor.render(Math.max(10, innerW - 2))) lines.push(row(` ${line}`));
		} else {
			const opts = q.type === "yesNo" ? ["Yes", "No"] : [...(q.options ?? []), ...(this.config.choiceQuestion.allowOther ? ["Other"] : [])];
			const current = this.answers[this.index]?.answer;
			for (let i = 0; i < opts.length; i++) {
				const selected = i === this.selectedOption;
				const checked = q.type === "multipleChoice" && Array.isArray(current) && current.includes(opts[i]!);
				const marker = q.type === "multipleChoice" ? (checked ? "[x]" : "[ ]") : selected ? "●" : "○";
				const label = opts[i] === "Other" && selected ? `Other: ${this.otherText}` : opts[i]!;
				lines.push(row(` ${selected ? th.fg("accent", ">") : " "} ${marker} ${selected ? th.fg("accent", label) : label}`));
			}
		}

		lines.push(row(""));
		lines.push(row(` ${th.fg("dim", "Alt+←/→ browse • Ctrl+Enter next • Ctrl+Shift+S skip • Esc cancel")}`));
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

export default function piAnwser(pi: ExtensionAPI) {
	let config: PiAnwserConfig = DEFAULT_CONFIG;
	let lastQuestions: Question[] = [];
	let lastAnswers: Answer[] = [];
	let popupOpen = false;

	async function askQuestions(ctx: ExtensionContext, questions: Question[]): Promise<Answer[] | null> {
		if (!ctx.hasUI || !config.enabled || questions.length === 0) return null;
		popupOpen = true;
		try {
			const answers = await ctx.ui.custom<Answer[] | null>((tui, theme, _kb, done) => new QuestionOverlay(tui, theme, config, questions, done), {
				overlay: true,
				overlayOptions: { anchor: "right-center", width: config.popup.width, minWidth: 44, maxHeight: "90%", margin: 1 },
			});
			if (!answers) return null;
			lastAnswers = answers;
			if (config.persistence.saveAnswersInSession) pi.appendEntry("pi-anwser.answers", { answers, timestamp: Date.now() });
			return answers;
		} finally {
			popupOpen = false;
		}
	}

	async function reviewAndMaybeSend(ctx: ExtensionContext, answers: Answer[], send: boolean): Promise<string | null> {
		let message = formatAnswers(answers, config);
		if (config.review.enabled) {
			const reviewed = await ctx.ui.editor(config.review.editorTitle, message);
			if (reviewed === undefined) return null;
			message = reviewed;
		}
		if (config.review.askConfirmationBeforeSend) {
			const ok = await ctx.ui.confirm("Send answers?", "Send the reviewed answers to the assistant?");
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

	async function runAutomatic(ctx: ExtensionContext, text: string) {
		if (!config.enabled || !config.trigger.automaticDetection || popupOpen || !ctx.hasUI) return;
		const questions = detectQuestions(text, config);
		if (questions.length === 0) return;
		lastQuestions = questions;
		if (config.persistence.saveLastQuestions) pi.appendEntry("pi-anwser.questions", { questions, timestamp: Date.now() });
		const answers = await askQuestions(ctx, questions);
		if (!answers) return;
		await reviewAndMaybeSend(ctx, answers, true);
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			config = await loadConfig(ctx.cwd);
		} catch (error) {
			ctx.ui.notify(`pi-anwser config error: ${(error as Error).message}`, "error");
			config = DEFAULT_CONFIG;
		}
		ctx.ui.setStatus("pi-anwser", config.enabled ? ctx.ui.theme.fg("accent", "anwser:on") : ctx.ui.theme.fg("dim", "anwser:off"));
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

	pi.registerTool({
		name: "ask_user_questions",
		label: "Ask User Questions",
		description: "Ask the user one or more questions in a right-side popup overlay. Use when progress depends on user input, preferences, missing requirements, or a choice among options.",
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
			}));
			lastQuestions = questions;
			const answers = await askQuestions(ctx, questions);
			if (!answers) return { content: [{ type: "text", text: "User cancelled the question overlay." }], details: { answers: [] as Answer[] } };
			const reviewed = await reviewAndMaybeSend(ctx, answers, false);
			return {
				content: [{ type: "text", text: reviewed ?? formatAnswers(answers, config) }],
				details: { answers, reviewed },
			};
		},
		renderCall(args: any, theme: Theme) {
			const count = Array.isArray(args?.questions) ? args.questions.length : 0;
			return { render: (width: number) => [truncateToWidth(theme.fg("toolTitle", theme.bold("ask_user_questions ")) + theme.fg("muted", `${count} question(s)`), width)], invalidate() {} };
		},
		renderResult(result: any, _options: any, theme: Theme) {
			const answers = result?.details?.answers as Answer[] | undefined;
			const text = answers?.length ? theme.fg("success", `✓ answered ${answers.length} question(s)`) : theme.fg("warning", "No answers");
			return { render: (width: number) => [truncateToWidth(text, width)], invalidate() {} };
		},
	});

	pi.registerCommand("pi-anwser", {
		description: "Configure Pi Anwser: status, on, off, test, last, reload-config.",
		handler: async (args, ctx) => {
			const cmd = args.trim() || "status";
			if (cmd === "on") config.enabled = true;
			else if (cmd === "off") config.enabled = false;
			else if (cmd === "reload-config") config = await loadConfig(ctx.cwd);
			else if (cmd === "test") {
				const qs: Question[] = [
					{ id: "name", type: "open", label: "What should I call this feature?", required: false },
					{ id: "opts", type: "multipleChoice", label: "Which outputs should be shown?", options: ["tools", "thinking", "bash"], required: false },
				];
				const answers = await askQuestions(ctx, qs);
				if (answers) await reviewAndMaybeSend(ctx, answers, true);
				return;
			} else if (cmd === "last") {
				if (lastQuestions.length === 0) ctx.ui.notify("No previous questions", "info");
				else {
					const answers = await askQuestions(ctx, lastQuestions);
					if (answers) await reviewAndMaybeSend(ctx, answers, true);
				}
				return;
			} else if (cmd !== "status") {
				ctx.ui.notify("Usage: /pi-anwser [status|on|off|test|last|reload-config]", "error");
				return;
			}
			ctx.ui.setStatus("pi-anwser", config.enabled ? ctx.ui.theme.fg("accent", "anwser:on") : ctx.ui.theme.fg("dim", "anwser:off"));
			ctx.ui.notify(`pi-anwser ${config.enabled ? "on" : "off"}; last questions=${lastQuestions.length}; last answers=${lastAnswers.length}`, "info");
		},
	});

	pi.registerShortcut(DEFAULT_CONFIG.shortcuts.toggleOverlay as KeyId, {
		description: "Toggle/reopen pi-anwser for last questions",
		handler: async (ctx) => {
			if (popupOpen) return;
			if (lastQuestions.length === 0) {
				ctx.ui.notify("pi-anwser: no previous questions", "info");
				return;
			}
			const answers = await askQuestions(ctx, lastQuestions);
			if (answers) await reviewAndMaybeSend(ctx, answers, true);
		},
	});
}
