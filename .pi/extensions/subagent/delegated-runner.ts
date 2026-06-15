import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

export interface DelegatedRunOptions {
	cwd: string;
	prompt: string;
	model?: string;
	tools?: string[];
	signal?: AbortSignal;
	onOutput?: (text: string) => void;
}

export interface DelegatedRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	finalText: string;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	return { command: "pi", args };
}

function extractAssistantText(message: any): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export async function runDelegatedReview(options: DelegatedRunOptions): Promise<DelegatedRunResult> {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (options.model) args.push("--model", options.model);
	if (options.tools && options.tools.length > 0) {
		args.push("--tools", options.tools.join(","));
	}
	args.push(options.prompt);

	const invocation = getPiInvocation(args);
	let stdout = "";
	let stderr = "";
	let finalText = "";
	let buffer = "";

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let settled = false;

		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			if (buffer.trim()) processLine(buffer);
			if (abortHandler) {
				options.signal?.removeEventListener("abort", abortHandler);
			}
			resolve(code);
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			stdout += `${line}\n`;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "message_end" && event.message) {
				const text = extractAssistantText(event.message);
				if (text) {
					finalText = text;
					options.onOutput?.(text);
				}
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code, signalName) => {
			if (signalName && !stderr.trim()) {
				stderr = `Delegated Pi process terminated by signal: ${signalName}`;
			}
			finish(code ?? 0);
		});

		proc.on("error", (error) => {
			stderr += `${error.message}\n`;
			finish(1);
		});

		const abortHandler = () => {
			stderr += "Delegated Pi process aborted by parent signal.\n";
			proc.kill("SIGTERM");
			setTimeout(() => proc.kill("SIGKILL"), 5000);
		};
		if (options.signal) {
			if (options.signal.aborted) abortHandler();
			options.signal.addEventListener("abort", abortHandler, { once: true });
		}
	});

	if (!finalText) {
		finalText = stderr.trim() || "No review output produced.";
	}

	return { exitCode, stdout: stdout.trim(), stderr: stderr.trim(), finalText };
}

export async function resolveExistingPaths(cwd: string, rawArgs: string): Promise<string[]> {
	const paths = rawArgs
		.split(/\s+/)
		.map((value) => value.trim())
		.filter(Boolean)
		.map((value) => value.replace(/^@/, ""));

	const resolved: string[] = [];
	for (const candidate of paths) {
		const absolutePath = path.resolve(cwd, candidate);
		try {
			const stats = await fs.stat(absolutePath);
			if (stats.isDirectory()) {
				const entries = await fs.readdir(absolutePath, { withFileTypes: true });
				const markdownFiles = entries
					.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
					.map((entry) => path.posix.join(candidate.replace(/\\/g, "/").replace(/\/$/, ""), entry.name))
					.slice(0, 5);
				const suggestion =
					markdownFiles.length > 0
						? ` Did you mean one of these files? ${markdownFiles.join(", ")}`
						: "";
				throw new Error(`Expected a file path, got a directory: ${candidate}.${suggestion}`);
			}
			resolved.push(absolutePath);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Expected a file path")) {
				throw error;
			}
			throw new Error(`Path not found: ${candidate}`);
		}
	}

	return resolved;
}
