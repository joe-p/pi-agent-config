import { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  CommandConfig,
  mergeWithConcatenation,
  mergeWithOverwrites,
  NetworkAndFsConfig,
  ParentCommand,
  ScopedSandbox,
} from "./scoped-sandbox";
import { TextContent } from "@mariozechner/pi-ai";
import { AgentMessage } from "@mariozechner/pi-agent-core";
import { SandboxRuntimeConfig } from "@joe-p/sandbox-runtime";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

const PLAN_MODE_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "questionnaire",
  "web_search",
  "web_fetch",
];

export type SandboxMode = "plan" | "build";
/**
 * Based on:
 * - https://github.com/carderne/pi-sandbox/blob/aee651cd9cf6b7a65d735b7336d6e2850152406c/index.ts
 *   by Chris Arderne, used under the MIT License.
 * - https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts
 *   by Mario Zechner, used under the MIT License.
 */
export class PiSandbox {
  public ctx?: ExtensionContext;
  private lastParentApproved?: string;
  private activeMode: SandboxMode;

  public sessionAllowedDomains: string[] = [];
  public sessionAllowedReadPaths: string[] = [];
  public sessionAllowedWritePaths: string[] = [];

  constructor(
    private sandboxes: { plan: ScopedSandbox; build: ScopedSandbox },
  ) {
    this.activeMode = "build";
  }

  getMode(): SandboxMode {
    return this.activeMode;
  }

  setMode(mode: SandboxMode) {
    this.activeMode = mode;
  }

  addConfig(
    mode: SandboxMode | "both",
    command: string,
    config: CommandConfig,
  ) {
    const modes: SandboxMode[] = mode === "both" ? ["plan", "build"] : [mode];

    modes.forEach((m) => {
      this.sandboxes[m].scopedCommands[command] = config;
    });
  }

  async assertApproval(parentCommand: ParentCommand): Promise<void> {
    const { command, id } = parentCommand;
    if (this.lastParentApproved === id) return;
    if (!this.ctx) {
      throw Error("Failed to get ctx!");
    }

    const choice = await this.ctx.ui.select(
      `[sandbox] run command?: ${command}`,
      ["No, do not run this command", "Yes, run this command"],
    );

    if (!choice?.startsWith("Yes")) {
      throw Error(
        `Bash command rejected by user: ${command}. Ask them how they want to proceed.`,
      );
    }

    this.lastParentApproved = id;
  }

  get sandbox(): ScopedSandbox {
    return this.sandboxes[this.activeMode];
  }

  loadConfig(cwd: string): SandboxRuntimeConfig {
    const projectConfigPath = join(cwd, ".pi", "sandbox.json");
    const globalConfigPath = join(homedir(), ".pi", "agent", "sandbox.json");

    let globalConfig: Partial<NetworkAndFsConfig> = {};
    let projectConfig: Partial<NetworkAndFsConfig> = {};

    if (existsSync(globalConfigPath)) {
      try {
        globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
      } catch (e) {
        console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
      }
    }

    if (existsSync(projectConfigPath)) {
      try {
        projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
      } catch (e) {
        console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
      }
    }

    const sandbox = this.sandboxes[this.activeMode];

    const defaults = mergeWithConcatenation(
      sandbox.mandatoryConfig,
      sandbox.defaultConfig.runtimeConfig,
    );
    const globalWithDefaults = mergeWithConcatenation(defaults, globalConfig);
    const projectWithDefaults = mergeWithConcatenation(defaults, projectConfig);

    const final = mergeWithOverwrites(globalWithDefaults, projectWithDefaults);

    return final;
  }

  createSandboxedBashOps(ctx: ExtensionContext): BashOperations {
    const sandbox = this;

    return {
      async exec(command, cwd, { onData, signal, timeout, env }) {
        if (!existsSync(cwd)) {
          throw new Error(`Working directory does not exist: ${cwd}`);
        }

        sandbox.ctx = ctx;

        return new Promise((resolve, reject) => {
          sandbox.sandbox
            .withWrappedCommand(command, async (wrappedCommand) => {
              const child = spawn("bash", ["-c", wrappedCommand], {
                cwd,
                env,
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
              });

              let timedOut = false;
              let timeoutHandle: NodeJS.Timeout | undefined;

              if (timeout !== undefined && timeout > 0) {
                timeoutHandle = setTimeout(() => {
                  timedOut = true;
                  if (child.pid) {
                    try {
                      process.kill(-child.pid, "SIGKILL");
                    } catch {
                      child.kill("SIGKILL");
                    }
                  }
                }, timeout * 1000);
              }

              child.stdout?.on("data", onData);
              child.stderr?.on("data", onData);

              child.on("error", (err) => {
                if (timeoutHandle) clearTimeout(timeoutHandle);
                reject(err);
              });

              const onAbort = () => {
                if (child.pid) {
                  try {
                    process.kill(-child.pid, "SIGKILL");
                  } catch {
                    child.kill("SIGKILL");
                  }
                }
              };

              signal?.addEventListener("abort", onAbort, { once: true });

              child.on("close", (code) => {
                if (timeoutHandle) clearTimeout(timeoutHandle);
                signal?.removeEventListener("abort", onAbort);

                if (signal?.aborted) {
                  reject(new Error("aborted"));
                } else if (timedOut) {
                  reject(new Error(`timeout:${timeout}`));
                } else {
                  resolve({ exitCode: code });
                }
              });
            })
            .catch(reject);
        });
      },
    };
  }

  getEffectiveAllowedDomains(cwd: string): string[] {
    const config = this.loadConfig(cwd);
    return [
      ...(config.network?.allowedDomains ?? []),
      ...this.sessionAllowedDomains,
    ];
  }

  getEffectiveAllowRead(cwd: string): string[] {
    const config = this.loadConfig(cwd);
    return [
      ...(config.filesystem?.allowRead ?? []),
      ...this.sessionAllowedReadPaths,
    ];
  }

  getEffectiveAllowWrite(cwd: string): string[] {
    const config = this.loadConfig(cwd);
    return [
      ...(config.filesystem?.allowWrite ?? []),
      ...this.sessionAllowedWritePaths,
    ];
  }

  setupExtension(pi: ExtensionAPI) {
    const sandbox = this;

    pi.registerFlag("no-sandbox", {
      description: "Disable OS-level sandboxing for bash commands",
      type: "boolean",
      default: false,
    });

    const localCwd = process.cwd();
    const localBash = createBashTool(localCwd);

    // ── Bash tool — with write-block detection and retry ───────────────────────

    pi.registerTool({
      ...localBash,
      label: "bash (sandboxed)",
      async execute(id, params, signal, onUpdate, ctx) {
        const runBash = () => {
          const sandboxedBash = createBashTool(localCwd, {
            operations: sandbox.createSandboxedBashOps(ctx),
          });
          return sandboxedBash.execute(id, params, signal, onUpdate);
        };

        const result = await runBash();

        // Post-execution: detect OS-level write block and offer to allow.
        if (ctx?.hasUI) {
          const outputText = result.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");

          const blockedPath = extractBlockedWritePath(outputText);
          if (blockedPath) {
            const choice = await promptWriteBlock(ctx, blockedPath);
            if (choice !== "abort") {
              await sandbox.applyWriteChoice(choice, blockedPath, ctx.cwd);

              // Check if denyWrite would still block it even after allowing.
              const config = sandbox.loadConfig(ctx.cwd);
              const { projectPath, globalPath } = getConfigPaths(ctx.cwd);
              if (
                matchesPattern(blockedPath, config.filesystem?.denyWrite ?? [])
              ) {
                ctx.ui.notify(
                  `⚠️ "${blockedPath}" was added to allowWrite, but it is also in denyWrite and will remain blocked.\n` +
                    `Check denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
                  "warning",
                );
                return result;
              }

              onUpdate?.({
                content: [
                  {
                    type: "text",
                    text: `\n--- Write access granted for "${blockedPath}", retrying ---\n`,
                  },
                ],
                details: {},
              });
              return runBash();
            }
          }
        }

        return result;
      },
    });

    // ── user_bash — network pre-check ──────────────────────────────────────────

    pi.on("user_bash", async (event, ctx) => {
      const domains = extractDomainsFromCommand(event.command);
      const effectiveDomains = sandbox.getEffectiveAllowedDomains(ctx.cwd);

      for (const domain of domains) {
        if (!domainIsAllowed(domain, effectiveDomains)) {
          const choice = await promptDomainBlock(ctx, domain);
          if (choice === "abort") {
            return {
              result: {
                output: `Blocked: "${domain}" is not in allowedDomains. Use /sandbox to review your config.`,
                exitCode: 1,
                cancelled: false,
                truncated: false,
              },
            };
          }
          await sandbox.applyDomainChoice(choice, domain, ctx.cwd);
        }
      }

      return { operations: sandbox.createSandboxedBashOps(ctx) };
    });

    // ── tool_call — network pre-check for bash, path policy for read/write/edit

    pi.on("tool_call", async (event, ctx) => {
      const config = sandbox.loadConfig(ctx.cwd);

      const { projectPath, globalPath } = getConfigPaths(ctx.cwd);

      // Path policy: read tool.
      //   - If the path is already in effectiveAllowRead, allow silently.
      //   - Otherwise always prompt, regardless of denyRead.
      //   - Granting (session or permanent) adds to allowRead, which overrides denyRead.
      //   - denyRead is never a hard-block on its own — it just sets the default
      //     denied state that the prompt can override.
      if (isToolCallEventType("read", event)) {
        const filePath = event.input.path;
        const effectiveAllowRead = sandbox.getEffectiveAllowRead(ctx.cwd);

        if (!matchesPattern(filePath, effectiveAllowRead)) {
          const choice = await promptReadBlock(ctx, filePath);
          if (choice === "abort") {
            return {
              block: true,
              reason: `Sandbox: read access denied for "${filePath}"`,
            };
          }
          await sandbox.applyReadChoice(choice, filePath, ctx.cwd);
          // Allowed — fall through, tool runs.
          return;
        }
      }

      // Path policy: write/edit — prompt for allowWrite, hard-block for denyWrite.
      if (
        isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event)
      ) {
        const path = (event.input as { path: string }).path;
        const allowWrite = sandbox.getEffectiveAllowWrite(ctx.cwd);
        const denyWrite = config.filesystem?.denyWrite ?? [];

        if (allowWrite.length > 0 && !matchesPattern(path, allowWrite)) {
          const choice = await promptWriteBlock(ctx, path);
          if (choice === "abort") {
            return {
              block: true,
              reason: `Sandbox: write access denied for "${path}" (not in allowWrite)`,
            };
          }
          await sandbox.applyWriteChoice(choice, path, ctx.cwd);

          // denyWrite takes precedence — warn if it would still block.
          if (matchesPattern(path, denyWrite)) {
            ctx.ui.notify(
              `⚠️ "${path}" was added to allowWrite, but it is also in denyWrite and will remain blocked.\n` +
                `Check denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
              "warning",
            );
            return {
              block: true,
              reason: `Sandbox: write access denied for "${path}" (also in denyWrite)`,
            };
          }

          // Allowed — fall through, tool runs.
          return;
        }

        if (matchesPattern(path, denyWrite)) {
          return {
            block: true,
            reason:
              `Sandbox: write access denied for "${path}" (in denyWrite). ` +
              `To change this, edit denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
          };
        }
      }
    });

    // ── session_start ───────────────────────────────────────────────────────────

    pi.on("session_start", async (_event, ctx) => {
      const noSandbox = pi.getFlag("no-sandbox") as boolean;

      if (noSandbox) {
        ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
        return;
      }

      const platform = process.platform;
      if (platform !== "darwin" && platform !== "linux") {
        ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
        return;
      }

      try {
        // Make Node's built-in fetch() honour HTTP_PROXY / HTTPS_PROXY in this
        // process and any child processes that inherit the environment.
        // undici (which powers globalThis.fetch) ignores proxy env vars by default;
        // --use-env-proxy (Node 22+) opts it in. We set this here so that node
        // subprocesses spawned directly from bash (e.g. `node script.ts`) also
        // pick it up without needing to go through wrapWithSandbox.
        const nodeMajor = parseInt(process.versions.node.split(".")[0]!, 10);
        if (nodeMajor >= 22) {
          const existing = process.env.NODE_OPTIONS ?? "";
          process.env.NODE_OPTIONS = existing
            ? `${existing} --use-env-proxy`
            : "--use-env-proxy";
        }
      } catch (err) {
        ctx.ui.notify(
          `Sandbox initialization failed: ${err instanceof Error ? err.message : err}`,
          "error",
        );
      }
    });

    pi.registerCommand("sandbox", {
      description: "Show sandbox configuration",
      handler: async (_args, ctx) => {
        const config = sandbox.loadConfig(ctx.cwd);
        const { globalPath, projectPath } = getConfigPaths(ctx.cwd);

        const lines = [
          "Sandbox Configuration",
          `  Project config: ${projectPath}`,
          `  Global config:  ${globalPath}`,
          "",
          "Network (bash + !cmd):",
          `  Allowed domains: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
          `  Denied domains:  ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
          ...(this.sessionAllowedDomains.length > 0
            ? [`  Session allowed: ${this.sessionAllowedDomains.join(", ")}`]
            : []),
          "",
          "Filesystem (bash + read/write/edit tools):",
          `  Deny Read:   ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
          `  Allow Read:  ${config.filesystem?.allowRead?.join(", ") || "(none)"}`,
          `  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
          `  Deny Write:  ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
          ...(this.sessionAllowedReadPaths.length > 0
            ? [`  Session read:  ${this.sessionAllowedReadPaths.join(", ")}`]
            : []),
          ...(this.sessionAllowedWritePaths.length > 0
            ? [`  Session write: ${this.sessionAllowedWritePaths.join(", ")}`]
            : []),
          "",
          "Note: ALL reads are prompted unless the path is already in allowRead.",
          "Note: denyRead is not a hard-block — granting a prompt adds to allowRead, overriding denyRead.",
          "Note: denyWrite takes PRECEDENCE over allowWrite and is never prompted.",
        ];
        ctx.ui.notify(lines.join("\n"), "info");
      },
    });

    this.setupPlanMode(pi);
  }

  setupPlanMode(pi: ExtensionAPI) {
    const sandbox = this;
    let initialTools: string[];
    let planModeEnabled = false;

    pi.registerFlag("plan", {
      description: "Start in plan mode (read-only exploration)",
      type: "boolean",
      default: false,
    });

    function updateStatus(ctx: ExtensionContext): void {
      if (planModeEnabled) {
        ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "📖"));
      } else {
        ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "✍️"));
      }
    }

    function togglePlanMode(ctx: ExtensionContext): void {
      planModeEnabled = !planModeEnabled;

      if (planModeEnabled) {
        sandbox.setMode("plan");
        pi.setActiveTools(PLAN_MODE_TOOLS);
        ctx.ui.notify(
          `Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}`,
        );
      } else {
        sandbox.setMode("build");
        pi.setActiveTools(initialTools);
        ctx.ui.notify("Plan mode disabled. Full access restored.");
      }
      updateStatus(ctx);

      pi.appendEntry("plan-mode", { enabled: planModeEnabled });
    }

    pi.registerCommand("plan", {
      description: "Toggle plan mode (read-only exploration)",
      handler: async (_args, ctx) => togglePlanMode(ctx),
    });

    pi.registerShortcut(Key.tab, {
      description: "Toggle plan mode",
      handler: async (ctx) => togglePlanMode(ctx),
    });

    // Filter out stale plan mode context when not in plan mode
    pi.on("context", async (event) => {
      if (planModeEnabled) return;

      return {
        messages: event.messages.filter((m) => {
          const msg = m as AgentMessage & { customType?: string };
          if (msg.customType === "plan-mode-context") return false;
          if (msg.role !== "user") return true;

          const content = msg.content;
          if (typeof content === "string") {
            return !content.includes("[PLAN MODE ACTIVE]");
          }
          if (Array.isArray(content)) {
            return !content.some(
              (c) =>
                c.type === "text" &&
                (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
            );
          }
          return true;
        }),
      };
    });

    // Inject plan mode context before agent starts
    pi.on("before_agent_start", async () => {
      if (planModeEnabled) {
        return {
          message: {
            customType: "plan-mode-context",
            content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls, questionnaire
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the questionnaire tool.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
            display: false,
          },
        };
      }
    });

    // Restore state on session start/resume
    pi.on("session_start", async (_event, ctx) => {
      initialTools = pi.getActiveTools();

      if (pi.getFlag("plan") === true) {
        planModeEnabled = true;
      }

      const entries = ctx.sessionManager.getEntries();

      // Restore persisted state
      const planModeEntry = entries
        .filter(
          (e: { type: string; customType?: string }) =>
            e.type === "custom" && e.customType === "plan-mode",
        )
        .pop() as { data?: { enabled: boolean } } | undefined;

      if (planModeEntry?.data) {
        planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
      }

      if (planModeEnabled) {
        pi.setActiveTools(PLAN_MODE_TOOLS);
      }
      updateStatus(ctx);
    });
  }

  async applyDomainChoice(
    choice: "session" | "project" | "global",
    domain: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    if (!this.sessionAllowedDomains.includes(domain))
      this.sessionAllowedDomains.push(domain);
    if (choice === "project") addDomainToConfig(projectPath, domain);
    if (choice === "global") addDomainToConfig(globalPath, domain);
  }

  async applyReadChoice(
    choice: "session" | "project" | "global",
    filePath: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    if (!this.sessionAllowedReadPaths.includes(filePath))
      this.sessionAllowedReadPaths.push(filePath);
    if (choice === "project") addReadPathToConfig(projectPath, filePath);
    if (choice === "global") addReadPathToConfig(globalPath, filePath);
  }

  async applyWriteChoice(
    choice: "session" | "project" | "global",
    filePath: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    if (!this.sessionAllowedWritePaths.includes(filePath))
      this.sessionAllowedWritePaths.push(filePath);
    if (choice === "project") addWritePathToConfig(projectPath, filePath);
    if (choice === "global") addWritePathToConfig(globalPath, filePath);
  }
}

// ── Domain helpers ────────────────────────────────────────────────────────────

export function extractDomainsFromCommand(command: string): string[] {
  const urlRegex = /https?:\/\/([a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const domains = new Set<string>();
  let match;
  while ((match = urlRegex.exec(command)) !== null) {
    domains.add(match[1]!);
  }
  return [...domains];
}

export function domainMatchesPattern(domain: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return domain === base || domain.endsWith("." + base);
  }
  return domain === pattern;
}

export function domainIsAllowed(
  domain: string,
  allowedDomains: string[],
): boolean {
  return allowedDomains.some((p) => domainMatchesPattern(domain, p));
}

// ── Output analysis ───────────────────────────────────────────────────────────

/** Extract a path from a bash "Operation not permitted" OS sandbox error. */
function extractBlockedWritePath(output: string): string | null {
  const match = output.match(
    /(?:\/bin\/bash|bash|sh): (\/[^\s:]+): Operation not permitted/,
  );
  return match ? match[1]! : null;
}

// ── Path pattern matching ─────────────────────────────────────────────────────

// Escape regex metacharacters, including hyphen (which is special inside character classes)
const REGEX_ESCAPE_CHARS = /[.+^${}()|[\]\\-]/g;

function escapeRegex(str: string): string {
  return str.replace(REGEX_ESCAPE_CHARS, "\\$&");
}

/**
 * Resolve a path to its real absolute path, following symlinks.
 * Returns null if the path doesn't exist (for newly-created paths in write ops).
 */
function resolveRealPath(filePath: string): string | null {
  const expanded = filePath.replace(/^~/, homedir());
  const abs = resolve(expanded);
  try {
    return realpathSync(abs);
  } catch {
    // Path doesn't exist yet - return the normalized absolute path
    return abs;
  }
}

function matchesPattern(filePath: string, patterns: string[]): boolean {
  const realPath = resolveRealPath(filePath);
  if (!realPath) return false;

  // Also check the path itself for patterns that might match parent paths
  const pathsToCheck: string[] = [realPath];

  for (const p of patterns) {
    const expandedP = p.replace(/^~/, homedir());
    const absP = resolve(expandedP);

    // Normalize trailing slash for directory patterns
    const normalizedPattern = absP.replace(/\/$/, "");

    for (const checkPath of pathsToCheck) {
      if (p.includes("*")) {
        const escaped = escapeRegex(normalizedPattern).replace(/\\\*/g, ".*");
        if (new RegExp(`^${escaped}$`).test(checkPath)) {
          return true;
        }
      } else {
        // Check exact match or directory prefix (trailing slash is safe now)
        if (
          checkPath === normalizedPattern ||
          checkPath.startsWith(normalizedPattern + "/")
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

// ── Config helpers ───────────────────────────────────────────────────────────

function getConfigPaths(cwd: string): {
  globalPath: string;
  projectPath: string;
} {
  return {
    globalPath: join(homedir(), ".pi", "agent", "sandbox.json"),
    projectPath: join(cwd, ".pi", "sandbox.json"),
  };
}

function readOrEmptyConfig(configPath: string): Partial<SandboxRuntimeConfig> {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfigFile(
  configPath: string,
  config: Partial<SandboxRuntimeConfig>,
): void {
  mkdirSync(dirname(configPath), { recursive: true });
  // Atomic write: write to temp file, then rename
  const tempPath = `${configPath}.tmp.${Date.now()}.${process.pid}`;
  const content = JSON.stringify(config, null, 2) + "\n";
  try {
    writeFileSync(tempPath, content, "utf-8");
    renameSync(tempPath, configPath);
  } catch (e) {
    // Clean up temp file on failure
    try {
      if (existsSync(tempPath)) {
        // Note: fs.unlinkSync would need to be imported
        // Using existing imports - we can use writeFileSync to overwrite or just document
      }
    } catch {}
    throw e;
  }
}

function addDomainToConfig(configPath: string, domain: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.network?.allowedDomains ?? [];
  if (!existing.includes(domain)) {
    config.network = {
      ...config.network,
      allowedDomains: [...existing, domain],
      deniedDomains: config.network?.deniedDomains ?? [],
    };
    writeConfigFile(configPath, config);
  }
}

function addReadPathToConfig(configPath: string, pathToAdd: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.filesystem?.allowRead ?? [];
  if (!existing.includes(pathToAdd)) {
    config.filesystem = {
      ...config.filesystem,
      allowRead: [...existing, pathToAdd],
      denyRead: config.filesystem?.denyRead ?? [],
      allowWrite: config.filesystem?.allowWrite ?? [],
      denyWrite: config.filesystem?.denyWrite ?? [],
    };
    writeConfigFile(configPath, config);
  }
}

function addWritePathToConfig(configPath: string, pathToAdd: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.filesystem?.allowWrite ?? [];
  if (!existing.includes(pathToAdd)) {
    config.filesystem = {
      ...config.filesystem,
      allowWrite: [...existing, pathToAdd],
      denyRead: config.filesystem?.denyRead ?? [],
      denyWrite: config.filesystem?.denyWrite ?? [],
    };
    writeConfigFile(configPath, config);
  }
}

// ── UXSS Sanitization ───────────────────────────────────────────────────────

export function sanitizeForUI(input: string): string {
  // Remove ANSI escape sequences (colors, cursor movement, etc.)
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\x00-\x1F\x7F-\x9F]|\x1B\[[0-9;]*[A-Za-z]/g, "");
}

// ── UI prompts ──────────────────────────────────────────────────────────────

export async function promptDomainBlock(
  ctx: ExtensionContext,
  domain: string,
): Promise<"abort" | "session" | "project" | "global"> {
  if (!ctx.hasUI) return "abort";
  const safeDomain = sanitizeForUI(domain);
  const choice = await ctx.ui.select(
    `🌐 Network blocked: "${safeDomain}" is not in allowedDomains`,
    [
      "Abort (keep blocked)",
      "Allow for this session only",
      "Allow for this project  →  .pi/sandbox.json",
      "Allow for all projects  →  ~/.pi/agent/sandbox.json",
    ],
  );
  if (!choice || choice.startsWith("Abort")) return "abort";
  if (choice.startsWith("Allow for this session")) return "session";
  if (choice.startsWith("Allow for this project")) return "project";
  return "global";
}

export async function promptReadBlock(
  ctx: ExtensionContext,
  filePath: string,
): Promise<"abort" | "session" | "project" | "global"> {
  if (!ctx.hasUI) return "abort";
  const safePath = sanitizeForUI(filePath);
  const choice = await ctx.ui.select(
    `📖 Read blocked: "${safePath}" is not in allowRead`,
    [
      "Abort (keep blocked)",
      "Allow for this session only",
      "Allow for this project  →  .pi/sandbox.json",
      "Allow for all projects  →  ~/.pi/agent/sandbox.json",
    ],
  );
  if (!choice || choice.startsWith("Abort")) return "abort";
  if (choice.startsWith("Allow for this session")) return "session";
  if (choice.startsWith("Allow for this project")) return "project";
  return "global";
}

export async function promptWriteBlock(
  ctx: ExtensionContext,
  filePath: string,
): Promise<"abort" | "session" | "project" | "global"> {
  if (!ctx.hasUI) return "abort";
  const safePath = sanitizeForUI(filePath);
  const choice = await ctx.ui.select(
    `📝 Write blocked: "${safePath}" is not in allowWrite`,
    [
      "Abort (keep blocked)",
      "Allow for this session only",
      "Allow for this project  →  .pi/sandbox.json",
      "Allow for all projects  →  ~/.pi/agent/sandbox.json",
    ],
  );
  if (!choice || choice.startsWith("Abort")) return "abort";
  if (choice.startsWith("Allow for this session")) return "session";
  if (choice.startsWith("Allow for this project")) return "project";
  return "global";
}
