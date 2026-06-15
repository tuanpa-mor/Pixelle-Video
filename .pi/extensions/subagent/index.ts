import type { ExtensionAPI, ExtensionContext, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import {
	buildExplorePrompt,
	buildReadinessBriefPrompt,
	buildReviewPlanPrompt,
	buildReviewReadinessPrompt,
	buildReviewSpecPrompt,
} from "./prompts.ts";
import { resolveExistingPaths, runDelegatedReview } from "./delegated-runner.ts";

const REVIEW_TOOLS = ["read"];
const EXPLORE_TOOLS = ["read", "bash"];
const STATUS_KEY = "subagent";
const WIDGET_KEY = "subagent-progress";
const SUBAGENT_ACTIVE_FILE = ".pi/workflows/.subagent-active";
const LOADING_INDICATOR_ID = "subagent-loading";
const STATUS_CLEAR_DELAY_MS = 4000;
const PROGRESS_CLEAR_DELAY_MS = 8000;
const RESULT_PREVIEW_LIMIT = 1200;
const MESSAGE_BODY_PREVIEW_LIMIT = 600;
const PROGRESS_ACTIVITY_LIMIT = 4;
const LONG_RUNNING_AFTER_MS = 15000;
const SUBAGENT_VIETNAMESE_RULE = [
	"Additional required rule:",
	"- Respond in Vietnamese.",
	"- If the prompt requires an exact output format, required headings, labels, checklist markers, or file structure, keep that format exactly as requested and write the content under it in Vietnamese.",
	"- Keep code, identifiers, file paths, and command names unchanged unless the task explicitly asks to translate them.",
].join("\n");
let clearStatusTimer: ReturnType<typeof setTimeout> | undefined;
let clearProgressTimer: ReturnType<typeof setTimeout> | undefined;
let progressRefreshTimer: ReturnType<typeof setInterval> | undefined;

function getLoadingIndicator(ctx: ExtensionContext): WorkingIndicatorOptions {
	const theme = ctx.ui.theme;
	return {
		frames: [
			theme.fg("accent", "⠋"),
			theme.fg("accent", "⠙"),
			theme.fg("accent", "⠹"),
			theme.fg("accent", "⠸"),
			theme.fg("accent", "⠼"),
			theme.fg("accent", "⠴"),
			theme.fg("accent", "⠦"),
			theme.fg("accent", "⠧"),
			theme.fg("accent", "⠇"),
			theme.fg("accent", "⠏"),
		],
		intervalMs: 80,
	};
}

function cancelStatusClearTimer() {
	if (clearStatusTimer) {
		clearTimeout(clearStatusTimer);
		clearStatusTimer = undefined;
	}
}

function scheduleStatusClear(ctx: ExtensionContext) {
	cancelStatusClearTimer();
	clearStatusTimer = setTimeout(() => {
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// Ignore stale extension context after command/session teardown.
		}
		clearStatusTimer = undefined;
	}, STATUS_CLEAR_DELAY_MS);
}

function setRunningStatus(ctx: ExtensionContext, label: string) {
	cancelStatusClearTimer();
	const theme = ctx.ui.theme;
	ctx.ui.setWorkingIndicator(getLoadingIndicator(ctx));
	ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", "◌") + theme.fg("dim", ` ${label}...`));
}

function setDoneStatus(ctx: ExtensionContext, label: string, isSuccess: boolean) {
	const theme = ctx.ui.theme;
	const icon = isSuccess ? theme.fg("success", "✓") : theme.fg("warning", "!");
	ctx.ui.setWorkingIndicator();
	ctx.ui.setStatus(STATUS_KEY, icon + theme.fg("dim", ` ${label}`));
	scheduleStatusClear(ctx);
}

function showLoadingMessage(_pi: ExtensionAPI, _label: string) {
	// Intentionally no-op: avoid high-contrast custom follow-up cards for transient loading state.
}

function getSubagentActivePath(cwd: string) {
	return path.join(cwd, SUBAGENT_ACTIVE_FILE);
}

async function markSubagentActive(cwd: string) {
	const activePath = getSubagentActivePath(cwd);
	await fs.mkdir(path.dirname(activePath), { recursive: true });
	await fs.writeFile(activePath, `${Date.now()}\n`, "utf8");
}

async function clearSubagentActive(cwd: string) {
	try {
		await fs.unlink(getSubagentActivePath(cwd));
	} catch {
		// Ignore missing marker file.
	}
}

function hasFlag(args: string, flag: string): boolean {
	return new RegExp(`(^|\\s)${flag}(?=\\s|$)`).test(args);
}

function removeFlag(args: string, flag: string): string {
	return args.replace(new RegExp(`(^|\\s)${flag}(?=\\s|$)`, "g"), " ").replace(/\s+/g, " ").trim();
}

function getReviewPrefix(exitCode: number, successLabel: string, failureLabel: string): string {
	return exitCode === 0 ? `${successLabel}:\n\n` : `${failureLabel}:\n\n`;
}

function toPreview(text: string): string {
	return text.length <= RESULT_PREVIEW_LIMIT ? text : `${text.slice(0, RESULT_PREVIEW_LIMIT).trimEnd()}\n\n...[truncated]`;
}

function toCompactPreview(text: string): string {
	return text.length <= MESSAGE_BODY_PREVIEW_LIMIT ? text : `${text.slice(0, MESSAGE_BODY_PREVIEW_LIMIT).trimEnd()}\n...[truncated]`;
}

function withVietnameseRule(prompt: string): string {
	return `${prompt.trimEnd()}\n\n---\n${SUBAGENT_VIETNAMESE_RULE}\n`;
}

interface PlanPhase {
	name: string;
	tasks: string[];
}

interface ReadinessPacket {
	specPath: string;
	planPath: string;
	detailPaths: string[];
}

interface SubagentProgressState {
	mode: string;
	status: string;
	step: string;
	phase?: string;
	artifacts?: string;
	startedAt: number;
	activity: string[];
}

function cancelProgressTimers() {
	if (clearProgressTimer) {
		clearTimeout(clearProgressTimer);
		clearProgressTimer = undefined;
	}
	if (progressRefreshTimer) {
		clearInterval(progressRefreshTimer);
		progressRefreshTimer = undefined;
	}
}

function formatElapsed(startedAt: number): string {
	const elapsedMs = Math.max(0, Date.now() - startedAt);
	const totalSeconds = Math.floor(elapsedMs / 1000);
	const minutes = Math.floor(totalSeconds / 60)
		.toString()
		.padStart(2, "0");
	const seconds = (totalSeconds % 60).toString().padStart(2, "0");
	return `${minutes}:${seconds}`;
}

function getAnimatedBadge(theme: ExtensionContext["ui"]["theme"], startedAt: number): string {
	const frames = ["·", "•", "●", "•"] as const;
	const frame = frames[Math.floor((Date.now() - startedAt) / 350) % frames.length];
	return theme.fg("accent", frame);
}

function getProgressHeadline(theme: ExtensionContext["ui"]["theme"], state: SubagentProgressState): string {
	if (state.status === "complete") {
		return theme.fg("success", `✓ ${state.step}`);
	}
	if (state.status === "failed") {
		return theme.fg("warning", `! ${state.step}`);
	}
	return theme.fg("accent", `… ${state.step}`);
}

function getProgressMeta(state: SubagentProgressState): string {
	if (Date.now() - state.startedAt >= LONG_RUNNING_AFTER_MS) {
		return state.artifacts ? `${state.artifacts} · waiting for model` : "waiting for model";
	}
	return state.artifacts ?? "running";
}

function getProgressBackground(theme: ExtensionContext["ui"]["theme"], status: SubagentProgressState["status"], text: string): string {
	if (status === "complete") return theme.bg("toolPendingBg", text);
	if (status === "failed") return theme.bg("selectedBg", text);
	return theme.bg("customMessageBg", text);
}

function renderProgressWidget(ctx: ExtensionContext, state: SubagentProgressState) {
	const elapsed = formatElapsed(state.startedAt);
	const badge = getAnimatedBadge(ctx.ui.theme, state.startedAt);
	const titleParts = [
		`${badge} ${ctx.ui.theme.bold(state.mode)}`,
		state.phase ? ctx.ui.theme.fg("muted", state.phase) : undefined,
		ctx.ui.theme.fg("dim", elapsed),
	].filter(Boolean);
	const latestActivity = state.activity.at(-1) ?? "starting";
	const box = new Box(1, 0, (text) => getProgressBackground(ctx.ui.theme, state.status, text));
	box.addChild(new Text(titleParts.join(ctx.ui.theme.fg("dim", "   ")), 0, 0));
	box.addChild(new Text(getProgressHeadline(ctx.ui.theme, state), 0, 0));
	box.addChild(new Text(ctx.ui.theme.fg("dim", `${getProgressMeta(state)} · ${latestActivity}`), 0, 0));

	ctx.ui.setWidget(WIDGET_KEY, () => box);
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "◌") + ctx.ui.theme.fg("dim", " sub-agent active"));
}

function startProgress(ctx: ExtensionContext, state: Omit<SubagentProgressState, "startedAt" | "activity"> & { activity?: string[] }) {
	cancelStatusClearTimer();
	cancelProgressTimers();
	void markSubagentActive(ctx.cwd);
	ctx.ui.setWorkingIndicator(getLoadingIndicator(ctx));
	ctx.ui.setWorkingMessage(`${state.status}...`);
	const progressState: SubagentProgressState = {
		...state,
		startedAt: Date.now(),
		activity: state.activity?.slice(-PROGRESS_ACTIVITY_LIMIT) ?? [],
	};
	renderProgressWidget(ctx, progressState);
	progressRefreshTimer = setInterval(() => {
		try {
			renderProgressWidget(ctx, progressState);
		} catch {
			cancelProgressTimers();
		}
	}, 1000);
	return progressState;
}

function updateProgress(ctx: ExtensionContext, state: SubagentProgressState, patch: Partial<Omit<SubagentProgressState, "startedAt" | "activity">>, activity?: string) {
	Object.assign(state, patch);
	if (activity) {
		state.activity.push(activity);
		state.activity = state.activity.slice(-PROGRESS_ACTIVITY_LIMIT);
	}
	renderProgressWidget(ctx, state);
}

function clearProgress(ctx: ExtensionContext) {
	cancelProgressTimers();
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	ctx.ui.setWorkingMessage();
	void clearSubagentActive(ctx.cwd);
}

function finishProgress(
	ctx: ExtensionContext,
	state: SubagentProgressState | undefined,
	options: { status: string; step: string; isSuccess: boolean; activity?: string },
) {
	if (!state) return;
	cancelProgressTimers();
	ctx.ui.setWorkingMessage();
	const theme = ctx.ui.theme;
	state.status = options.status;
	state.step = options.step;
	if (options.activity) {
		state.activity.push(options.activity);
		state.activity = state.activity.slice(-PROGRESS_ACTIVITY_LIMIT);
	}
	renderProgressWidget(ctx, state);
	const elapsed = formatElapsed(state.startedAt);
	const icon = options.isSuccess ? theme.fg("success", "✓") : theme.fg("warning", "!");
	ctx.ui.setWorkingIndicator();
	ctx.ui.setStatus(STATUS_KEY, icon + theme.fg("dim", ` sub-agent: ${options.status} · ${elapsed}`));
	void clearSubagentActive(ctx.cwd);
	scheduleStatusClear(ctx);
	clearProgressTimer = setTimeout(() => {
		try {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// Ignore stale extension context after command/session teardown.
		}
		clearProgressTimer = undefined;
	}, PROGRESS_CLEAR_DELAY_MS);
}

function stripEnrichSummary(content: string): string {
	const marker = "\n## Enrich Summary\n";
	const index = content.indexOf(marker);
	return index >= 0 ? content.slice(0, index).trimEnd() : content.trimEnd();
}

function parsePlanPhases(content: string): PlanPhase[] {
	const tasksSectionMatch = content.match(/## Tasks\s*\n([\s\S]*?)(?:\n## |$)/);
	if (!tasksSectionMatch) {
		throw new Error("Plan is missing a ## Tasks section.");
	}

	const section = tasksSectionMatch[1];
	const phaseRegex = /^###\s+(.+)$/gm;
	const phases: PlanPhase[] = [];
	const matches = [...section.matchAll(phaseRegex)];
	for (let index = 0; index < matches.length; index += 1) {
		const match = matches[index];
		const phaseName = match[1].trim();
		const start = match.index! + match[0].length;
		const end = index + 1 < matches.length ? matches[index + 1].index! : section.length;
		const block = section.slice(start, end);
		const tasks = [...block.matchAll(/^\s*- \[ \]\s+(.+)$/gm)].map((taskMatch) => taskMatch[1].trim());
		phases.push({ name: phaseName, tasks });
	}

	if (phases.length === 0) {
		throw new Error("Plan has no phases under ## Tasks.");
	}

	for (const phase of phases) {
		if (phase.tasks.length === 0) {
			throw new Error(`Phase \"${phase.name}\" has no unchecked tasks to enrich.`);
		}
	}

	return phases;
}

function normalizePhaseDisplayName(phaseName: string): string {
	return phaseName.replace(/^Phase\s+\d+:\s*/i, "").trim();
}

function parseExploreSection(result: string, sectionName: string): string[] {
	const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const headingVariants = [
		escapedName,
		`\\*\\*${escapedName}\\*\\*`,
		`\\*\\*${escapedName}:\\*\\*`,
		`###\\s+${escapedName}`,
	].join("|");
	const regex = new RegExp(`^(?:${headingVariants}):?\\s*\\r?\\n([\\s\\S]*?)(?=^(?:\\*\\*[A-Z][^\\n]*\\*\\*|###\\s+.+|[A-Z][^\\n:]*):?\\s*$|$)`, "m");
	const match = result.match(regex);
	if (!match) return [];
	return match[1]
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^[-*]\s+/.test(line) && line !== "- none" && line !== "* none")
		.map((line) => line.replace(/^\*\s+/, "- "));
}

function parseExploreJson(result: string): { filesToModify: string[]; filesToCreate: string[]; relevantSymbols: string[]; notes: string[] } | null {
	const trimmed = result.trim();
	const candidates: string[] = [];
	if (trimmed.startsWith("{")) candidates.push(trimmed);
	const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)```/i);
	if (fencedMatch) candidates.push(fencedMatch[1].trim());
	const bareMatch = trimmed.match(/\{[\s\S]*\}/);
	if (bareMatch) candidates.push(bareMatch[0].trim());

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as Record<string, unknown>;
			const normalize = (value: unknown) => Array.isArray(value)
				? value.map((item) => String(item).trim()).filter(Boolean).filter((item) => item.toLowerCase() !== "none")
				: [];
			return {
				filesToModify: normalize(parsed.filesToModify),
				filesToCreate: normalize(parsed.filesToCreate),
				relevantSymbols: normalize(parsed.relevantSymbols),
				notes: normalize(parsed.notes),
			};
		} catch {
			// Try next candidate.
		}
	}

	return null;
}

function formatPhaseDetails(phaseNumber: number, phaseName: string, exploreResult: string): string {
	const jsonResult = parseExploreJson(exploreResult);
	const filesToModify = jsonResult?.filesToModify ?? parseExploreSection(exploreResult, "Files to modify");
	const filesToCreate = jsonResult?.filesToCreate ?? parseExploreSection(exploreResult, "Files to create");
	const relevantSymbols = jsonResult?.relevantSymbols ?? parseExploreSection(exploreResult, "Relevant symbols");
	const notes = (jsonResult?.notes ?? parseExploreSection(exploreResult, "Notes")).slice(0, 3);
	const displayPhaseName = normalizePhaseDisplayName(phaseName);

	const sections = [`## Phase ${phaseNumber} Details — ${displayPhaseName}`, ""];
	sections.push("### Files to modify");
	sections.push(...(filesToModify.length > 0 ? filesToModify : ["- none"]));
	sections.push("");
	sections.push("### Files to create");
	sections.push(...(filesToCreate.length > 0 ? filesToCreate : ["- none"]));
	sections.push("");
	sections.push("### Relevant symbols");
	sections.push(...(relevantSymbols.length > 0 ? relevantSymbols : ["- none"]));
	if (notes.length > 0) {
		sections.push("");
		sections.push("### Notes");
		sections.push(...notes);
	}

	return sections.join("\n") + "\n";
}

function countNonNoneBullets(lines: string[]): number {
	return lines.filter((line) => line !== "- none").length;
}

function buildEnrichSummary(planPath: string, phaseSummaries: Array<{ name: string; detailPath: string; modified: number; created: number }>): string {
	const totalModified = phaseSummaries.reduce((sum, phase) => sum + phase.modified, 0);
	const totalCreated = phaseSummaries.reduce((sum, phase) => sum + phase.created, 0);
	const totalFiles = totalModified + totalCreated;
	const phaseBreakdown = phaseSummaries.map((phase) => `${phase.name}: ${phase.modified + phase.created} files`).join(" · ");
	const detailLines = phaseSummaries
		.map((phase, index) => {
			const relativeDetailPath = phase.detailPath.replace(/\\/g, "/");
			return `- Phase ${index + 1} → ${relativeDetailPath}`;
		})
		.join("\n");

	return `\n\n## Enrich Summary\nTotal files: ${totalFiles} (${totalModified} modified, ${totalCreated} created)\n${phaseBreakdown}\n\nDetails:\n${detailLines}\n`;
}

function getMessageStatus(details: unknown): "success" | "error" {
	const exitCode = typeof details === "object" && details && "exitCode" in details ? (details as { exitCode?: unknown }).exitCode : undefined;
	return exitCode === 0 || exitCode === undefined ? "success" : "error";
}

function registerSubagentMessageRenderer(pi: ExtensionAPI, customType: string, title: string) {
	pi.registerMessageRenderer(customType, (message, options, theme) => {
		const status = getMessageStatus(message.details);
		const icon = status === "success" ? theme.fg("success", "✓") : theme.fg("warning", "!");
		const titleColor = status === "success" ? "success" : "warning";
		const heading = `${icon} ${theme.fg(titleColor, theme.bold(title))}`;
		const preview = options.expanded ? String(message.content ?? "") : toCompactPreview(String(message.content ?? ""));
		const lines = [heading, "", preview];
		if (options.expanded && message.details && typeof message.details === "object") {
			const details = message.details as Record<string, unknown>;
			const meta: string[] = [];
			if (typeof details.exitCode === "number") meta.push(`exitCode=${details.exitCode}`);
			if (details.auto === true) meta.push("auto=true");
			if (typeof details.planPath === "string") meta.push(`plan=${details.planPath}`);
			if (typeof details.phases === "number") meta.push(`phases=${details.phases}`);
			if (meta.length > 0) {
				lines.push("");
				lines.push(theme.fg("dim", meta.join(" · ")));
			}
		}
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});
}

async function runDelegatedCommand(params: {
	cwd: string;
	prompt: string;
	signal: AbortSignal;
	tools: string[];
}) {
	return runDelegatedReview({
		cwd: params.cwd,
		prompt: withVietnameseRule(params.prompt),
		tools: params.tools,
		signal: params.signal,
	});
}

async function runReviewReadinessPacket(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	packet: ReadinessPacket,
	customType = "subagent-review-readiness",
): Promise<{ exitCode: number; finalText: string; stderr: string }> {
	ctx.ui.notify(`Running isolated readiness review for ${2 + packet.detailPaths.length} artifacts`, "info");
	const progress = startProgress(ctx, {
		mode: "review-readiness",
		status: "running",
		step: `reviewing ${2 + packet.detailPaths.length} artifacts`,
		artifacts: `${2 + packet.detailPaths.length} artifacts`,
		activity: ["Started delegated readiness review"],
	});
	setRunningStatus(ctx, "Delegated readiness review running");
	showLoadingMessage(pi, "readiness review");
	try {
		const result = await runDelegatedCommand({
			cwd: ctx.cwd,
			prompt: buildReviewReadinessPrompt(ctx.cwd, packet.specPath, packet.planPath, packet.detailPaths),
			tools: REVIEW_TOOLS,
			signal: ctx.signal,
		});

		finishProgress(ctx, progress, {
			status: result.exitCode === 0 ? "complete" : "failed",
			step: result.exitCode === 0 ? "review finished" : "review failed",
			isSuccess: result.exitCode === 0,
			activity: result.exitCode === 0 ? "Readiness review complete" : "Readiness review failed",
		});
		setDoneStatus(ctx, "Delegated readiness review complete", result.exitCode === 0);
		ctx.ui.notify(
			result.exitCode === 0 ? "Readiness review complete" : "Readiness review failed",
			result.exitCode === 0 ? "info" : "error",
		);
		pi.sendMessage(
			{
				customType,
				content: `${getReviewPrefix(result.exitCode, "Delegated readiness review complete", "Delegated readiness review failed")}${result.finalText}`,
				display: true,
				details: { exitCode: result.exitCode, stderr: result.stderr },
			},
			{ triggerTurn: false, deliverAs: "followUp" },
		);

		return result;
	} catch (error) {
		finishProgress(ctx, progress, {
			status: "failed",
			step: "review failed",
			isSuccess: false,
			activity: error instanceof Error ? error.message : "Readiness review failed",
		});
		setDoneStatus(ctx, "Delegated readiness review failed", false);
		throw error;
	}
}

export default function subagentExtension(pi: ExtensionAPI) {
	registerSubagentMessageRenderer(pi, "subagent-review-plan", "Sub-agent plan review");
	registerSubagentMessageRenderer(pi, "subagent-review-spec", "Sub-agent spec review");
	registerSubagentMessageRenderer(pi, "subagent-review-readiness", "Sub-agent readiness review");
	registerSubagentMessageRenderer(pi, "subagent-readiness-brief", "Sub-agent readiness brief");
	registerSubagentMessageRenderer(pi, "subagent-enrich-plan", "Sub-agent enrich plan");

	pi.registerCommand("review-plan", {
		description: "Review a plan file before enrichment with an isolated delegated Pi run",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /review-plan @docs/ai/plans/<file>.md", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current run to finish before starting a delegated review.", "warning");
				return;
			}

			let progress: SubagentProgressState | undefined;
			try {
				const [planPath] = await resolveExistingPaths(ctx.cwd, args);
				ctx.ui.notify(`Running isolated plan review for ${planPath}`, "info");
				progress = startProgress(ctx, {
					mode: "review-plan",
					status: "running",
					step: "reviewing plan file",
					artifacts: "1 plan file",
					activity: ["Started delegated plan review"],
				});
				setRunningStatus(ctx, "Delegated plan review running");
				showLoadingMessage(pi, "plan review");
				const result = await runDelegatedCommand({
					cwd: ctx.cwd,
					prompt: buildReviewPlanPrompt(ctx.cwd, planPath),
					tools: REVIEW_TOOLS,
					signal: ctx.signal,
				});

				finishProgress(ctx, progress, {
					status: result.exitCode === 0 ? "complete" : "failed",
					step: result.exitCode === 0 ? "plan review finished" : "plan review failed",
					isSuccess: result.exitCode === 0,
					activity: result.exitCode === 0 ? "Plan review complete" : "Plan review failed",
				});
				setDoneStatus(ctx, "Delegated plan review complete", result.exitCode === 0);
				ctx.ui.notify(result.exitCode === 0 ? "Plan review complete" : "Plan review failed", result.exitCode === 0 ? "info" : "error");
				pi.sendMessage(
					{
						customType: "subagent-review-plan",
						content: `${getReviewPrefix(result.exitCode, "Delegated plan review complete", "Delegated plan review failed")}${result.finalText}`,
						display: true,
						details: { exitCode: result.exitCode, stderr: result.stderr },
					},
					{ triggerTurn: false, deliverAs: "followUp" },
				);
			} catch (error) {
				finishProgress(ctx, progress, {
					status: "failed",
					step: "plan review failed",
					isSuccess: false,
					activity: error instanceof Error ? error.message : "Plan review failed",
				});
				setDoneStatus(ctx, "Delegated plan review failed", false);
				ctx.ui.notify(error instanceof Error ? error.message : "Plan review failed", "error");
			}
		},
	});

	pi.registerCommand("review-spec", {
		description: "Review a spec file with an isolated delegated Pi run",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /review-spec @docs/ai/specs/<file>.md", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current run to finish before starting a delegated review.", "warning");
				return;
			}

			let progress: SubagentProgressState | undefined;
			try {
				const [specPath] = await resolveExistingPaths(ctx.cwd, args);
				ctx.ui.notify(`Running isolated spec review for ${specPath}`, "info");
				progress = startProgress(ctx, {
					mode: "review-spec",
					status: "running",
					step: "reviewing spec file",
					artifacts: "1 spec file",
					activity: ["Started delegated spec review"],
				});
				setRunningStatus(ctx, "Delegated spec review running");
				showLoadingMessage(pi, "spec review");
				const result = await runDelegatedCommand({
					cwd: ctx.cwd,
					prompt: buildReviewSpecPrompt(ctx.cwd, specPath),
					tools: REVIEW_TOOLS,
					signal: ctx.signal,
				});

				finishProgress(ctx, progress, {
					status: result.exitCode === 0 ? "complete" : "failed",
					step: result.exitCode === 0 ? "spec review finished" : "spec review failed",
					isSuccess: result.exitCode === 0,
					activity: result.exitCode === 0 ? "Spec review complete" : "Spec review failed",
				});
				setDoneStatus(ctx, "Delegated spec review complete", result.exitCode === 0);
				ctx.ui.notify(result.exitCode === 0 ? "Spec review complete" : "Spec review failed", result.exitCode === 0 ? "info" : "error");
				pi.sendMessage(
					{
						customType: "subagent-review-spec",
						content: `${getReviewPrefix(result.exitCode, "Delegated spec review complete", "Delegated spec review failed")}${result.finalText}`,
						display: true,
						details: { exitCode: result.exitCode, stderr: result.stderr },
					},
					{ triggerTurn: false, deliverAs: "followUp" },
				);
			} catch (error) {
				finishProgress(ctx, progress, {
					status: "failed",
					step: "spec review failed",
					isSuccess: false,
					activity: error instanceof Error ? error.message : "Spec review failed",
				});
				setDoneStatus(ctx, "Delegated spec review failed", false);
				ctx.ui.notify(error instanceof Error ? error.message : "Spec review failed", "error");
			}
		},
	});

	pi.registerCommand("readiness-brief", {
		description: "Summarize the top execution focus areas from a reviewed artifact packet",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /readiness-brief @spec.md @plan.md @detail-1.md [@detail-2.md ...]", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current run to finish before starting a delegated review.", "warning");
				return;
			}

			let progress: SubagentProgressState | undefined;
			try {
				const resolvedPaths = await resolveExistingPaths(ctx.cwd, args);
				if (resolvedPaths.length < 3) {
					ctx.ui.notify("Provide at least a spec, a plan, and one details file.", "warning");
					return;
				}

				const [specPath, planPath, ...detailPaths] = resolvedPaths;
				ctx.ui.notify(`Running isolated readiness brief for ${resolvedPaths.length} artifacts`, "info");
				progress = startProgress(ctx, {
					mode: "readiness-brief",
					status: "running",
					step: `summarizing ${resolvedPaths.length} artifacts`,
					artifacts: `${resolvedPaths.length} artifacts`,
					activity: ["Started delegated readiness brief"],
				});
				setRunningStatus(ctx, "Delegated readiness brief running");
				showLoadingMessage(pi, "readiness brief");
				const result = await runDelegatedCommand({
					cwd: ctx.cwd,
					prompt: buildReadinessBriefPrompt(ctx.cwd, specPath, planPath, detailPaths),
					tools: REVIEW_TOOLS,
					signal: ctx.signal,
				});

				finishProgress(ctx, progress, {
					status: result.exitCode === 0 ? "complete" : "failed",
					step: result.exitCode === 0 ? "brief finished" : "brief failed",
					isSuccess: result.exitCode === 0,
					activity: result.exitCode === 0 ? "Readiness brief complete" : "Readiness brief failed",
				});
				setDoneStatus(ctx, "Delegated readiness brief complete", result.exitCode === 0);
				ctx.ui.notify(result.exitCode === 0 ? "Readiness brief complete" : "Readiness brief failed", result.exitCode === 0 ? "info" : "error");
				pi.sendMessage(
					{
						customType: "subagent-readiness-brief",
						content: `${getReviewPrefix(result.exitCode, "Delegated readiness brief complete", "Delegated readiness brief failed")}${result.finalText}`,
						display: true,
						details: { exitCode: result.exitCode, stderr: result.stderr },
					},
					{ triggerTurn: false, deliverAs: "followUp" },
				);
			} catch (error) {
				finishProgress(ctx, progress, {
					status: "failed",
					step: "brief failed",
					isSuccess: false,
					activity: error instanceof Error ? error.message : "Readiness brief failed",
				});
				setDoneStatus(ctx, "Delegated readiness brief failed", false);
				ctx.ui.notify(error instanceof Error ? error.message : "Readiness brief failed", "error");
			}
		},
	});

	pi.registerCommand("review-readiness", {
		description: "Review planning artifacts with an isolated delegated Pi run",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /review-readiness @spec.md @plan.md @detail-1.md [@detail-2.md ...] [--brief]", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current run to finish before starting a delegated review.", "warning");
				return;
			}

			try {
				const withBrief = hasFlag(args, "--brief");
				const cleanedArgs = removeFlag(args, "--brief");
				const resolvedPaths = await resolveExistingPaths(ctx.cwd, cleanedArgs);
				if (resolvedPaths.length < 3) {
					ctx.ui.notify("Provide at least a spec, a plan, and one details file.", "warning");
					return;
				}

				const [specPath, planPath, ...detailPaths] = resolvedPaths;
				await runReviewReadinessPacket(pi, ctx, { specPath, planPath, detailPaths });

				if (withBrief) {
					ctx.ui.notify("Auto-running readiness brief for the reviewed packet", "info");
					const progress = startProgress(ctx, {
						mode: "readiness-brief",
						status: "running",
						step: `summarizing ${resolvedPaths.length} artifacts`,
						artifacts: `${resolvedPaths.length} artifacts`,
						activity: ["Started follow-up readiness brief"],
					});
					setRunningStatus(ctx, "Delegated readiness brief running");
					showLoadingMessage(pi, "readiness brief");
					const briefResult = await runDelegatedCommand({
						cwd: ctx.cwd,
						prompt: buildReadinessBriefPrompt(ctx.cwd, specPath, planPath, detailPaths),
						tools: REVIEW_TOOLS,
						signal: ctx.signal,
					});
					finishProgress(ctx, progress, {
						status: briefResult.exitCode === 0 ? "complete" : "failed",
						step: briefResult.exitCode === 0 ? "brief finished" : "brief failed",
						isSuccess: briefResult.exitCode === 0,
						activity: briefResult.exitCode === 0 ? "Readiness brief complete" : "Readiness brief failed",
					});
					setDoneStatus(ctx, "Delegated readiness brief complete", briefResult.exitCode === 0);
					ctx.ui.notify(briefResult.exitCode === 0 ? "Readiness brief complete" : "Readiness brief failed", briefResult.exitCode === 0 ? "info" : "error");
					pi.sendMessage(
						{
							customType: "subagent-readiness-brief",
							content: `${getReviewPrefix(briefResult.exitCode, "Delegated readiness brief complete", "Delegated readiness brief failed")}${briefResult.finalText}`,
							display: true,
							details: { exitCode: briefResult.exitCode, stderr: briefResult.stderr, auto: true },
						},
						{ triggerTurn: false, deliverAs: "followUp" },
					);
				}
			} catch (error) {
				setDoneStatus(ctx, "Delegated readiness review failed", false);
				ctx.ui.notify(error instanceof Error ? error.message : "Readiness review failed", "error");
			}
		},
	});

	pi.registerCommand("enrich-plan-pi", {
		description: "Enrich a plan with Pi-only delegated phase exploration",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /enrich-plan-pi docs/ai/plans/<file>.md [--review-plan]", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current run to finish before starting delegated enrichment.", "warning");
				return;
			}

			let progress: SubagentProgressState | undefined;
			try {
				const withPlanReview = hasFlag(args, "--review-plan");
				const cleanedArgs = removeFlag(args, "--review-plan");
				if (!cleanedArgs) {
					ctx.ui.notify("Usage: /enrich-plan-pi docs/ai/plans/<file>.md [--review-plan]", "warning");
					return;
				}
				const resolvedPlanPaths = await resolveExistingPaths(ctx.cwd, cleanedArgs);
				if (resolvedPlanPaths.length === 0) {
					ctx.ui.notify("Usage: /enrich-plan-pi docs/ai/plans/<file>.md [--review-plan]", "warning");
					return;
				}
				const planAbsolutePath = resolvedPlanPaths[0];
				const planRelativePath = path.relative(ctx.cwd, planAbsolutePath).replace(/\\/g, "/");

				progress = startProgress(ctx, {
					mode: "enrich-plan-pi",
					status: "running",
					step: "preparing plan enrichment",
					artifacts: "0 detail files",
					activity: [`Started enrich for ${planRelativePath}`],
				});

				if (withPlanReview) {
					ctx.ui.notify("Auto-running plan review before enrichment", "info");
					updateProgress(ctx, progress, { step: "reviewing plan before enrich" }, "Started plan review before enrich");
					setRunningStatus(ctx, "Delegated plan review running");
					showLoadingMessage(pi, "plan review");
					const planReviewResult = await runDelegatedCommand({
						cwd: ctx.cwd,
						prompt: buildReviewPlanPrompt(ctx.cwd, planAbsolutePath),
						tools: REVIEW_TOOLS,
						signal: ctx.signal,
					});
					updateProgress(
						ctx,
						progress,
						{ step: planReviewResult.exitCode === 0 ? "plan review finished" : "plan review failed" },
						planReviewResult.exitCode === 0 ? "Plan review complete" : "Plan review failed",
					);
					setDoneStatus(ctx, "Delegated plan review complete", planReviewResult.exitCode === 0);
					ctx.ui.notify(planReviewResult.exitCode === 0 ? "Plan review complete" : "Plan review failed", planReviewResult.exitCode === 0 ? "info" : "error");
					pi.sendMessage(
						{
							customType: "subagent-review-plan",
							content: `${getReviewPrefix(planReviewResult.exitCode, "Delegated plan review complete", "Delegated plan review failed")}${planReviewResult.finalText}`,
							display: true,
							details: { exitCode: planReviewResult.exitCode, stderr: planReviewResult.stderr, auto: true },
						},
						{ triggerTurn: false, deliverAs: "followUp" },
					);
				}

				const originalPlan = await fs.readFile(planAbsolutePath, "utf8");
				const phases = parsePlanPhases(originalPlan);
				const planDir = path.dirname(planAbsolutePath);
				const planBaseName = path.basename(planAbsolutePath, path.extname(planAbsolutePath));
				const phaseSummaries: Array<{ name: string; detailPath: string; modified: number; created: number }> = [];

				ctx.ui.notify(`Running Pi-only enrich for ${phases.length} phase(s)`, "info");
				showLoadingMessage(pi, "plan enrichment");
				updateProgress(ctx, progress, { step: "exploring plan phases", phase: `0/${phases.length}` }, `Loaded ${phases.length} phase(s)`);

				for (let index = 0; index < phases.length; index += 1) {
					const phase = phases[index];
					updateProgress(ctx, progress, {
						step: "mapping files and symbols for current phase",
						phase: `${index + 1}/${phases.length} — ${normalizePhaseDisplayName(phase.name)}`,
						artifacts: `${phaseSummaries.length} detail file${phaseSummaries.length === 1 ? "" : "s"} created`,
					}, `Exploring phase ${index + 1}/${phases.length}: ${normalizePhaseDisplayName(phase.name)}`);
					setRunningStatus(ctx, `Exploring ${phase.name}`);
					const result = await runDelegatedReview({
						cwd: ctx.cwd,
						prompt: withVietnameseRule(buildExplorePrompt(phase.name, phase.tasks)),
						tools: EXPLORE_TOOLS,
						signal: ctx.signal,
					});

					const detailAbsolutePath = path.join(planDir, `${planBaseName}-phase-${index + 1}-details.md`);
					const detailRelativePath = path.relative(ctx.cwd, detailAbsolutePath).replace(/\\/g, "/");
					const detailContent = formatPhaseDetails(index + 1, phase.name, result.finalText);
					await fs.writeFile(detailAbsolutePath, detailContent, "utf8");

					phaseSummaries.push({
						name: phase.name,
						detailPath: detailRelativePath,
						modified: countNonNoneBullets(parseExploreJson(result.finalText)?.filesToModify ?? parseExploreSection(result.finalText, "Files to modify")),
						created: countNonNoneBullets(parseExploreJson(result.finalText)?.filesToCreate ?? parseExploreSection(result.finalText, "Files to create")),
					});
					updateProgress(ctx, progress, {
						artifacts: `${phaseSummaries.length} detail file${phaseSummaries.length === 1 ? "" : "s"} created`,
						step: "writing phase details",
					}, `Phase ${index + 1} complete → ${detailRelativePath}`);
				}

				updateProgress(ctx, progress, { step: "updating enrich summary" }, "Updating enrich summary in plan file");
				const updatedPlan = stripEnrichSummary(originalPlan) + buildEnrichSummary(planRelativePath, phaseSummaries);
				await fs.writeFile(planAbsolutePath, updatedPlan.endsWith("\n") ? updatedPlan : `${updatedPlan}\n`, "utf8");

				finishProgress(ctx, progress, {
					status: "complete",
					step: "enrich summary updated",
					isSuccess: true,
					activity: "Enrich summary updated",
				});
				setDoneStatus(ctx, "Pi-only enrich complete", true);
				ctx.ui.notify(`Enrich complete: ${phaseSummaries.length} phase(s)`, "info");
				pi.sendMessage(
					{
						customType: "subagent-enrich-plan",
						content: `Pi-only enrich complete for ${planRelativePath}.\n\nGenerated details:\n${phaseSummaries.map((phase, index) => `- Phase ${index + 1}: ${phase.detailPath}`).join("\n")}`,
						display: true,
						details: { planPath: planRelativePath, phases: phaseSummaries.length, autoReviewed: withPlanReview },
					},
					{ triggerTurn: false, deliverAs: "followUp" },
				);
			} catch (error) {
				finishProgress(ctx, progress, {
					status: "failed",
					step: "enrichment failed",
					isSuccess: false,
					activity: error instanceof Error ? error.message : "Pi-only enrich failed",
				});
				setDoneStatus(ctx, "Pi-only enrich failed", false);
				ctx.ui.notify(error instanceof Error ? error.message : "Pi-only enrich failed", "error");
			}
		},
	});

	pi.registerTool({
		name: "explore_phase",
		label: "Explore Phase",
		description: "Internal read-only explore worker for enrich-plan",
		parameters: Type.Object({
			phaseName: Type.String({ description: "Phase name from the plan" }),
			tasks: Type.Array(Type.String(), { description: "Intent-based tasks for this phase" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const phaseName = params.phaseName.trim();
			const tasks = params.tasks.map((task) => task.trim()).filter(Boolean);
			if (!phaseName) {
				return {
					content: [{ type: "text", text: "Files to modify:\n- none\n\nFiles to create:\n- none\n\nRelevant symbols:\n- none\n\nNotes:\n- invalid input: phaseName is required" }],
					details: { exitCode: 1, stderr: "phaseName is required" },
				};
			}
			if (tasks.length === 0) {
				return {
					content: [{ type: "text", text: "Files to modify:\n- none\n\nFiles to create:\n- none\n\nRelevant symbols:\n- none\n\nNotes:\n- invalid input: at least one task is required" }],
					details: { exitCode: 1, stderr: "at least one task is required" },
				};
			}

			const progress = startProgress(ctx, {
				mode: "explore_phase",
				status: "running",
				step: "exploring files and symbols for phase",
				phase: normalizePhaseDisplayName(phaseName),
				artifacts: `${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
				activity: [`Started explore for ${normalizePhaseDisplayName(phaseName)}`],
			});
			setRunningStatus(ctx, `Exploring ${phaseName}`);
			try {
				const result = await runDelegatedReview({
					cwd: ctx.cwd,
					prompt: withVietnameseRule(buildExplorePrompt(phaseName, tasks)),
					tools: EXPLORE_TOOLS,
					signal,
				});
				finishProgress(ctx, progress, {
					status: result.exitCode === 0 ? "complete" : "failed",
					step: result.exitCode === 0 ? "phase exploration finished" : "phase exploration failed",
					isSuccess: result.exitCode === 0,
					activity: result.exitCode === 0 ? `Explore complete for ${normalizePhaseDisplayName(phaseName)}` : `Explore failed for ${normalizePhaseDisplayName(phaseName)}`,
				});
				setDoneStatus(ctx, `Explore complete for ${phaseName}`, result.exitCode === 0);

				return {
					content: [{ type: "text", text: result.finalText }],
					details: { exitCode: result.exitCode, stderr: result.stderr },
				};
			} catch (error) {
				finishProgress(ctx, progress, {
					status: "failed",
					step: "phase exploration failed",
					isSuccess: false,
					activity: error instanceof Error ? error.message : `Explore failed for ${normalizePhaseDisplayName(phaseName)}`,
				});
				setDoneStatus(ctx, `Explore failed for ${phaseName}`, false);
				throw error;
			}
		},
	});
}
