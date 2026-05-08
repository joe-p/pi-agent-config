/**
 * GitLeaks Secret Detection Extension
 *
 * Scans tool outputs (read, bash) using GitLeaks before they are added
 * to the LLM context, preventing accidental exposure of secrets.
 *
 * Requires: gitleaks to be installed (https://github.com/gitleaks/gitleaks)
 * Install: brew install gitleaks
 *
 * Usage:
 *   pi -e ./gitleaks-guard.ts
 *
 * Or place in ~/.pi/agent/extensions/ for auto-discovery.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** GitLeaks finding structure */
interface GitLeaksFinding {
	RuleID?: string;
	Description?: string;
	StartLine?: number;
	EndLine?: number;
	StartColumn?: number;
	EndColumn?: number;
	Match?: string;
	Secret?: string;
	File?: string;
	SymlinkFile?: string;
	Commit?: string;
	Entropy?: number;
	Author?: string;
	Email?: string;
	Date?: string;
	Message?: string;
	Tags?: string[];
	Fingerprint?: string;
}

/** Scan result aggregate */
interface ScanResult {
	findings: GitLeaksFinding[];
	detectors: Set<string>;
}

/** Path to optional GitLeaks config file */
const CONFIG_PATH = join(homedir(), ".pi/agent/gitleaks.toml");

/** Check if gitleaks is available */
async function isGitLeaksAvailable(): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn("gitleaks", ["version"], { stdio: "ignore" });
		proc.on("error", () => resolve(false));
		proc.on("exit", (code) => resolve(code === 0));
	});
}

/** Scan content with gitleaks */
async function scanContent(content: string): Promise<ScanResult> {
	let stdoutData = "";
	let stderrData = "";

	// Build command args
	const args = ["detect", "--pipe", "--report-format", "json", "--report-path", "-"];
	if (existsSync(CONFIG_PATH)) {
		args.push("-c", CONFIG_PATH);
	}

	const proc = spawn("gitleaks", args, {
		stdio: ["pipe", "pipe", "pipe"],
	});

	// Collect stdout
	proc.stdout?.on("data", (data: Buffer) => {
		stdoutData += data.toString("utf8");
	});

	// Collect stderr for debugging
	proc.stderr?.on("data", (data: Buffer) => {
		stderrData += data.toString("utf8");
	});

	// Write content to stdin
	proc.stdin?.write(content);
	proc.stdin?.end();

	// Wait for completion
	await new Promise<void>((resolve, reject) => {
		proc.on("close", (code) => {
			// gitleaks exits 0 if no leaks, 1 if leaks found
			if (code === 0 || code === 1) {
				resolve();
			} else {
				reject(new Error(`gitleaks exited with code ${code}: ${stderrData}`));
			}
		});
		proc.on("error", reject);
	});

	// Parse findings from JSON output
	let findings: GitLeaksFinding[] = [];
	try {
		// Find the JSON array in stdout (gitleaks may log other info)
		const jsonMatch = stdoutData.match(/\[[\s\S]*\]/);
		if (jsonMatch) {
			findings = JSON.parse(jsonMatch[0]) as GitLeaksFinding[];
		}
	} catch {
		// If parsing fails, assume no findings
		findings = [];
	}

	const detectors = new Set<string>(
		findings.map((f) => f.RuleID ?? "unknown"),
	);

	return { findings, detectors };
}

/** Redact secrets from content based on findings */
function redactSecrets(content: string, findings: GitLeaksFinding[]): string {
	let redacted = content;

	// Sort by Secret length descending to avoid partial replacements
	const sortedFindings = [...findings].sort((a, b) => {
		const lenA = a.Secret?.length ?? 0;
		const lenB = b.Secret?.length ?? 0;
		return lenB - lenA;
	});

	for (const finding of sortedFindings) {
		if (!finding.Secret) continue;

		const detector = finding.RuleID ?? "secret";
		const replacement = `[${detector}: REDACTED]`;

		// Escape special regex characters
		const escaped = finding.Secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(escaped, "g");

		redacted = redacted.replace(regex, replacement);
	}

	return redacted;
}

/** Extract text content from tool result */
function extractContent(_toolName: string, content: unknown[]): string {
	if (!content || content.length === 0) return "";

	// Extract text from content parts
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "object" && part !== null) {
			if ("text" in part && typeof part.text === "string") {
				parts.push(part.text);
			}
		}
	}

	return parts.join("\n");
}

/** Format findings for display */
function formatFindings(result: ScanResult): string {
	const count = result.findings.length;
	const detectorList = Array.from(result.detectors).slice(0, 5);
	if (result.detectors.size > 5) {
		detectorList.push(`and ${result.detectors.size - 5} more`);
	}

	return `${count} secret${count === 1 ? "" : "s"} detected (${detectorList.join(", ")})`;
}

/** Main extension factory */
export default async function (pi: ExtensionAPI) {
	// Check if gitleaks is available
	const available = await isGitLeaksAvailable();
	if (!available) {
		console.warn(
			"[gitleaks-guard] GitLeaks not found. Install from https://github.com/gitleaks/gitleaks",
		);
		return;
	}

	console.log("[gitleaks-guard] Extension loaded");

	// Check for custom config
	if (existsSync(CONFIG_PATH)) {
		console.log(`[gitleaks-guard] Using custom config: ${CONFIG_PATH}`);
	}

	// Hook into tool results to scan content
	pi.on("tool_result", async (event, ctx) => {
		// Only scan read and bash tools
		if (event.toolName !== "read" && event.toolName !== "bash") {
			return undefined;
		}

		// Extract content to scan
		const textContent = extractContent(event.toolName, event.content);
		if (!textContent || textContent.length < 20) {
			return undefined; // Skip empty or very short content
		}

		// Skip binary content (contains null bytes)
		if (textContent.includes("\x00")) {
			return undefined;
		}

		try {
			// Scan the content
			const result = await scanContent(textContent);

			if (result.findings.length === 0) {
				return undefined; // No secrets found
			}

			// Redact the secrets from the content
			const redactedContent = redactSecrets(textContent, result.findings);

			// Format the warning
			const warning = `🚨 Secrets redacted in ${event.toolName} output: ${formatFindings(result)}`;

			if (ctx.hasUI) {
				// In interactive mode, show warning notification
				ctx.ui.notify(warning, "warning");
			} else {
				// In non-interactive mode, log to stderr
				console.error(`[gitleaks-guard] ${warning}`);
			}

			// Return redacted content
			return {
				content: [{ type: "text", text: redactedContent }],
				isError: false,
			};
		} catch (error) {
			// Log errors but don't block content
			console.error(
				"[gitleaks-guard] Scan error:",
				error instanceof Error ? error.message : String(error),
			);
			return undefined;
		}
	});
}
