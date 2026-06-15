function toRepoRelativePath(cwd: string, absolutePath: string): string {
	const normalizedCwd = cwd.replace(/\\/g, "/");
	const normalizedPath = absolutePath.replace(/\\/g, "/");
	if (normalizedPath.startsWith(normalizedCwd)) {
		return normalizedPath.slice(normalizedCwd.length).replace(/^\//, "") || normalizedPath;
	}
	return normalizedPath;
}

const OUTPUT_LIMIT_RULES = [
	"- Hard limit: keep the entire response under 1800 characters.",
	"- Each bullet must be one short sentence.",
	"- Keep at most 3 bullets per section.",
	"- Prioritize only the highest-signal issues; omit minor repetitions.",
].join("\n");

export function buildReviewPlanPrompt(cwd: string, planPath: string): string {
	const relativePlanPath = toRepoRelativePath(cwd, planPath);
	return `You are a delegated plan reviewer working in an isolated Pi session.

Goal:
Review the provided plan for readiness before enrichment.

Rules:
- Read only the provided plan file.
- Do not modify files.
- Focus on plan contract quality, task clarity, phase structure, obvious scope drift, and obvious coverage gaps.
- Keep the output concise and use the exact format below.
${OUTPUT_LIMIT_RULES}

Plan file:
- ${relativePlanPath}

Required output:
Verdict: pass | warn | fail
Ready for enrich-plan: yes | no

Plan contract issues:
- ...

Coverage gaps:
- ...

Ordering concerns:
- ...

Ambiguities:
- ...

If a section has no findings, write '- none'.`;
}

export function buildReviewSpecPrompt(cwd: string, specPath: string): string {
	const relativeSpecPath = toRepoRelativePath(cwd, specPath);
	return `You are a delegated spec reviewer working in an isolated Pi session.

Goal:
Review the provided spec for readiness before planning.

Rules:
- Read only the provided spec file.
- Do not modify files.
- Do not suggest implementation details, frameworks, or file mapping.
- Focus on structural correctness, AC verifiability, ambiguity, contradictions, and missing edge cases.
- Keep the output concise and use the exact format below.
${OUTPUT_LIMIT_RULES}

Spec file:
- ${relativeSpecPath}

Required output:
Verdict: pass | warn | fail
Ready for planning: yes | no

Issues:
- ...

Ambiguities:
- ...

Missing cases:
- ...

If a section has no findings, write '- none'.`;
}

export function buildReviewReadinessPrompt(cwd: string, specPath: string, planPath: string, detailPaths: string[]): string {
	const relativeSpecPath = toRepoRelativePath(cwd, specPath);
	const relativePlanPath = toRepoRelativePath(cwd, planPath);
	const relativeDetailPaths = detailPaths.map((detailPath) => `- ${toRepoRelativePath(cwd, detailPath)}`).join("\n");

	return `You are a delegated execution-readiness reviewer working in an isolated Pi session.

Goal:
Review the planning artifact packet for readiness before execution.

Rules:
- Read only the provided files.
- Do not modify files.
- Focus on plan contract issues, spec-to-plan coverage, plan-to-details coverage, scope drift, ordering concerns, and unresolved ambiguity.
- Keep the output concise and use the exact format below.
${OUTPUT_LIMIT_RULES}

Provided files:
- Spec: ${relativeSpecPath}
- Plan: ${relativePlanPath}
- Details:
${relativeDetailPaths}

Required output:
Verdict: pass | warn | fail
Ready for execute-plan: yes | no

Plan contract issues:
- ...

Spec -> Plan gaps:
- ...

Plan -> Details gaps:
- ...

Out-of-scope details:
- ...

Ordering / dependency concerns:
- ...

Residual ambiguity:
- ...

Human review focus:
- ...

If a section has no findings, write '- none'.`;
}

export function buildReadinessBriefPrompt(cwd: string, specPath: string, planPath: string, detailPaths: string[]): string {
	const relativeSpecPath = toRepoRelativePath(cwd, specPath);
	const relativePlanPath = toRepoRelativePath(cwd, planPath);
	const relativeDetailPaths = detailPaths.map((detailPath) => `- ${toRepoRelativePath(cwd, detailPath)}`).join("\n");

	return `You are a delegated execution-readiness brief writer working in an isolated Pi session.

Goal:
Summarize the most important execution focus areas from the provided artifact packet.

Rules:
- Read only the provided files.
- Do not modify files.
- Keep the output short, concrete, and execution-focused.
- Prefer the highest-risk gaps and decisions only.
- Use the exact format below.
${OUTPUT_LIMIT_RULES}

Provided files:
- Spec: ${relativeSpecPath}
- Plan: ${relativePlanPath}
- Details:
${relativeDetailPaths}

Required output:
Verdict: pass | warn | fail
Ready to start: yes | no

Top risks:
- ...

Open decisions:
- ...

Execution focus:
- ...

If a section has no findings, write '- none'.`;
}

export function buildExplorePrompt(phaseName: string, tasks: string[]): string {
	const taskLines = tasks.map((task) => `- ${task}`).join("\n");
	return `You are an Explore worker for plan enrichment.

Goal:
Inspect the codebase and map this phase into likely files and relevant symbols.

Rules:
- Read-only exploration only.
- Do not modify files.
- Focus on files to modify, files to create, relevant symbols, and critical dependency notes.
- Keep the output concise.
- Hard limit: keep the entire response under 1500 characters.
- Keep at most 5 files per section unless absolutely necessary.
- Notes section: maximum 2 bullets.
- If the repo is greenfield or the target files do not exist yet, infer the smallest realistic file set that should be created for this phase.
- Prefer concrete likely paths over abstract descriptions.
- For implementation phases, do not return all sections as 'none' unless the phase truly requires no file changes.
- Use common project conventions visible in the repo or implied by the plan (for example: src/components, src/hooks, src/types, src/utils, src/__tests__).
- Return only valid JSON. Do not wrap it in markdown fences.
- Do not add prose before or after the JSON.

Phase:
${phaseName}

Tasks:
${taskLines}

Required JSON schema:
{
  "filesToModify": ["path — reason", "..."],
  "filesToCreate": ["path — reason", "..."],
  "relevantSymbols": ["symbol — reason", "..."],
  "notes": ["short note", "..."]
}

If a field has no findings, return an empty array.`;
}
