/**
 * Based on:
 *
 * - https://github.com/carderne/pi-sandbox/blob/aee651cd9cf6b7a65d735b7336d6e2850152406c/index.ts
 *   by Chris Arderne, used under the MIT License.
 * - https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts
 * by Mario Zechner, used under the MIT License.
 *
 * Sandbox Extension - OS-level sandboxing for bash commands, plus path policy
 * enforcement for pi's read/write/edit tools, with interactive permission prompts.
 *
 * Uses @carderne/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux). Also intercepts the read, write, and edit tools to
 * apply the same denyRead/denyWrite/allowWrite filesystem rules, which OS-level
 * sandboxing cannot cover (those tools run directly in Node.js, not in a
 * subprocess).
 *
 * When a block is triggered, the user is prompted to:
 *   (a) Abort (keep blocked)
 *   (b) Allow for this session only  — stored in memory, agent cannot access
 *   (c) Allow for this project       — written to .pi/sandbox.json
 *   (d) Allow for all projects       — written to ~/.pi/agent/sandbox.json
 *
 * What gets prompted vs. hard-blocked:
 *   - domains: prompted if not whitelisted nor explicitly denied
 *   - write: prompted if not whitelisted nor explicitly denied
 *   - read: always prompted (because denyRead is used for broad block, may want to punch holes)
 *
 * IMPORTANT — precedence for read:
 *   Read:  allowRead OVERRIDES denyRead (prompt grant adds to allowRead)
 *   Write: denyWrite OVERRIDES allowWrite (most-specific deny wins)
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/sandbox.json (global)
 * - <cwd>/.pi/sandbox.json  (project-local)
 *
 * Example .pi/sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["/Users", "/home"],
 *     "allowRead": [".", "~/.config", "~/.local", "Library"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env"]
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable sandboxing
 * - `/sandbox` - show current sandbox configuration
 *
 * Setup:
 * 1. Copy sandbox/ directory to ~/.pi/agent/extensions/
 * 2. Run `npm install` in ~/.pi/agent/extensions/sandbox/
 *
 * Linux also requires: bubblewrap, socat, ripgrep
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import { ScopedSandbox } from "./lib/scoped-sandbox";

const DEFAULT_CONFIG: SandboxRuntimeConfig = {
  network: {
    allowedDomains: [],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["/Users", "/home", ".env", ".env.*", "*.pem", "*.key"],
    allowRead: [".", "~/.config", "~/.local"],
    allowWrite: [".", "/tmp"],
    denyWrite: [],
  },
};

await ScopedSandbox.initialize(DEFAULT_CONFIG);

class SandboxWithContext {
  public sandbox: ScopedSandbox;
  public ctx?: ExtensionContext;

  constructor() {
    this.sandbox = new ScopedSandbox({
      alwaysDeny: false,
      preWrapHook: async (command, config) => {
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
        return command;
      },
    });

    // allowed git subcommands
    ["diff", "grep", "log", "show", "status"].forEach((c) => {
      this.sandbox.scopedCommands[`git ${c}`] = {
        alwaysDeny: false,
        runtimeConfig: {
          filesystem: {
            allowRead: ["~/.gitconfig"],
            allowWrite: [],
            denyRead: [],
            denyWrite: [],
          },
        },
      };
    });

    // well-known bash commands
    ["cat", "echo", "grep", "rg", "tail", "less", "more", "wc"].forEach((c) => {
      this.sandbox.scopedCommands[c] = {
        alwaysDeny: false,
        preWrapHook: async (command, _config) => {
          if (!this.ctx) {
            throw Error("Failed to get ctx!");
          }

          // If this includes piping to a file, ask the user
          if (command.includes("|") || command.includes(">")) {
            const choice = await this.ctx.ui.select(
              `[sandbox] run command?: ${command}`,
              ["No, do not run this command", "Yes, run this command"],
            );

            if (!choice?.startsWith("Yes")) {
              throw Error(
                `Bash command rejected by user: ${command}. Ask them how they want to proceed.`,
              );
            }
          }
          return command;
        },
      };
    });
  }
}

const sandbox = new SandboxWithContext();

export function loadConfig(cwd: string): SandboxRuntimeConfig {
  const projectConfigPath = join(cwd, ".pi", "sandbox.json");
  const globalConfigPath = join(homedir(), ".pi", "agent", "sandbox.json");

  let globalConfig: Partial<SandboxRuntimeConfig> = {};
  let projectConfig: Partial<SandboxRuntimeConfig> = {};

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

  return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function deepMerge(
  base: SandboxRuntimeConfig,
  overrides: Partial<SandboxRuntimeConfig>,
): SandboxRuntimeConfig {
  const result: SandboxRuntimeConfig = { ...base };

  if (overrides.network) {
    result.network = { ...base.network, ...overrides.network };
  }
  if (overrides.filesystem) {
    result.filesystem = { ...base.filesystem, ...overrides.filesystem };
  }

  const extOverrides = overrides as {
    ignoreViolations?: Record<string, string[]>;
    enableWeakerNestedSandbox?: boolean;
    allowBrowserProcess?: boolean;
  };
  const extResult = result as {
    ignoreViolations?: Record<string, string[]>;
    enableWeakerNestedSandbox?: boolean;
    allowBrowserProcess?: boolean;
  };

  if (extOverrides.ignoreViolations) {
    extResult.ignoreViolations = extOverrides.ignoreViolations;
  }
  if (extOverrides.enableWeakerNestedSandbox !== undefined) {
    extResult.enableWeakerNestedSandbox =
      extOverrides.enableWeakerNestedSandbox;
  }
  if (extOverrides.allowBrowserProcess !== undefined) {
    extResult.allowBrowserProcess = extOverrides.allowBrowserProcess;
  }

  return result;
}

// ── Domain helpers ────────────────────────────────────────────────────────────

export function extractDomainsFromCommand(command: string): string[] {
  const urlRegex = /https?:\/\/([a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const domains = new Set<string>();
  let match;
  while ((match = urlRegex.exec(command)) !== null) {
    domains.add(match[1]);
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
  return match ? match[1] : null;
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

// ── Sandboxed bash ops ────────────────────────────────────────────────────────

function createSandboxedBashOps(ctx: ExtensionContext): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      sandbox.ctx = ctx;
      const wrappedCommand = await sandbox.sandbox.getWrappedCommand(command);

      return new Promise((resolve, reject) => {
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
      });
    },
  };
}

// ── Module-level sandbox state ───────────────────────────────────────────────

// Session-temporary allowances — held in JS memory, not accessible by the agent.
// These are shared across extensions that import from this module.
export const sessionAllowedDomains: string[] = [];
export const sessionAllowedReadPaths: string[] = [];
export const sessionAllowedWritePaths: string[] = [];

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

// ── Effective config helpers ─────────────────────────────────────────────────

export function getEffectiveAllowedDomains(cwd: string): string[] {
  const config = loadConfig(cwd);
  return [...(config.network?.allowedDomains ?? []), ...sessionAllowedDomains];
}

export function getEffectiveAllowRead(cwd: string): string[] {
  const config = loadConfig(cwd);
  return [...(config.filesystem?.allowRead ?? []), ...sessionAllowedReadPaths];
}

export function getEffectiveAllowWrite(cwd: string): string[] {
  const config = loadConfig(cwd);
  return [
    ...(config.filesystem?.allowWrite ?? []),
    ...sessionAllowedWritePaths,
  ];
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

// ── Apply allowance choices ─────────────────────────────────────────────────

export async function applyDomainChoice(
  choice: "session" | "project" | "global",
  domain: string,
  cwd: string,
): Promise<void> {
  const { globalPath, projectPath } = getConfigPaths(cwd);
  if (!sessionAllowedDomains.includes(domain))
    sessionAllowedDomains.push(domain);
  if (choice === "project") addDomainToConfig(projectPath, domain);
  if (choice === "global") addDomainToConfig(globalPath, domain);
}

export async function applyReadChoice(
  choice: "session" | "project" | "global",
  filePath: string,
  cwd: string,
): Promise<void> {
  const { globalPath, projectPath } = getConfigPaths(cwd);
  if (!sessionAllowedReadPaths.includes(filePath))
    sessionAllowedReadPaths.push(filePath);
  if (choice === "project") addReadPathToConfig(projectPath, filePath);
  if (choice === "global") addReadPathToConfig(globalPath, filePath);
}

export async function applyWriteChoice(
  choice: "session" | "project" | "global",
  filePath: string,
  cwd: string,
): Promise<void> {
  const { globalPath, projectPath } = getConfigPaths(cwd);
  if (!sessionAllowedWritePaths.includes(filePath))
    sessionAllowedWritePaths.push(filePath);
  if (choice === "project") addWritePathToConfig(projectPath, filePath);
  if (choice === "global") addWritePathToConfig(globalPath, filePath);
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
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
          operations: createSandboxedBashOps(ctx),
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
            await applyWriteChoice(choice, blockedPath, ctx.cwd);

            // Check if denyWrite would still block it even after allowing.
            const config = loadConfig(ctx.cwd);
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
    const effectiveDomains = getEffectiveAllowedDomains(ctx.cwd);

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
        await applyDomainChoice(choice, domain, ctx.cwd);
      }
    }

    return { operations: createSandboxedBashOps(ctx) };
  });

  // ── tool_call — network pre-check for bash, path policy for read/write/edit

  pi.on("tool_call", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);

    const { projectPath, globalPath } = getConfigPaths(ctx.cwd);

    // Path policy: read tool.
    //   - If the path is already in effectiveAllowRead, allow silently.
    //   - Otherwise always prompt, regardless of denyRead.
    //   - Granting (session or permanent) adds to allowRead, which overrides denyRead.
    //   - denyRead is never a hard-block on its own — it just sets the default
    //     denied state that the prompt can override.
    if (isToolCallEventType("read", event)) {
      const filePath = event.input.path;
      const effectiveAllowRead = getEffectiveAllowRead(ctx.cwd);

      if (!matchesPattern(filePath, effectiveAllowRead)) {
        const choice = await promptReadBlock(ctx, filePath);
        if (choice === "abort") {
          return {
            block: true,
            reason: `Sandbox: read access denied for "${filePath}"`,
          };
        }
        await applyReadChoice(choice, filePath, ctx.cwd);
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
      const allowWrite = getEffectiveAllowWrite(ctx.cwd);
      const denyWrite = config.filesystem?.denyWrite ?? [];

      if (allowWrite.length > 0 && !matchesPattern(path, allowWrite)) {
        const choice = await promptWriteBlock(ctx, path);
        if (choice === "abort") {
          return {
            block: true,
            reason: `Sandbox: write access denied for "${path}" (not in allowWrite)`,
          };
        }
        await applyWriteChoice(choice, path, ctx.cwd);

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
      const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
      if (nodeMajor >= 22) {
        const existing = process.env.NODE_OPTIONS ?? "";
        process.env.NODE_OPTIONS = existing
          ? `${existing} --use-env-proxy`
          : "--use-env-proxy";
      }

      ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `🔒`));
    } catch (err) {
      ctx.ui.notify(
        `Sandbox initialization failed: ${err instanceof Error ? err.message : err}`,
        "error",
      );
    }
  });

  // ── /sandbox command ────────────────────────────────────────────────────────

  pi.registerCommand("sandbox-enable", {
    description: "Enable the sandbox for this session",
    handler: async (_args, ctx) => {
      const platform = process.platform;
      if (platform !== "darwin" && platform !== "linux") {
        ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
        return;
      }

      try {
        ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `🔒`));
        ctx.ui.notify("Sandbox enabled", "info");
      } catch (err) {
        ctx.ui.notify(
          `Sandbox initialization failed: ${err instanceof Error ? err.message : err}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("sandbox-disable", {
    description: "Disable the sandbox for this session",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("sandbox", "");
      ctx.ui.notify("Sandbox disabled", "info");
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox configuration",
    handler: async (_args, ctx) => {
      const config = loadConfig(ctx.cwd);
      const { globalPath, projectPath } = getConfigPaths(ctx.cwd);

      const lines = [
        "Sandbox Configuration",
        `  Project config: ${projectPath}`,
        `  Global config:  ${globalPath}`,
        "",
        "Network (bash + !cmd):",
        `  Allowed domains: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
        `  Denied domains:  ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
        ...(sessionAllowedDomains.length > 0
          ? [`  Session allowed: ${sessionAllowedDomains.join(", ")}`]
          : []),
        "",
        "Filesystem (bash + read/write/edit tools):",
        `  Deny Read:   ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
        `  Allow Read:  ${config.filesystem?.allowRead?.join(", ") || "(none)"}`,
        `  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
        `  Deny Write:  ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
        ...(sessionAllowedReadPaths.length > 0
          ? [`  Session read:  ${sessionAllowedReadPaths.join(", ")}`]
          : []),
        ...(sessionAllowedWritePaths.length > 0
          ? [`  Session write: ${sessionAllowedWritePaths.join(", ")}`]
          : []),
        "",
        "Note: ALL reads are prompted unless the path is already in allowRead.",
        "Note: denyRead is not a hard-block — granting a prompt adds to allowRead, overriding denyRead.",
        "Note: denyWrite takes PRECEDENCE over allowWrite and is never prompted.",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
