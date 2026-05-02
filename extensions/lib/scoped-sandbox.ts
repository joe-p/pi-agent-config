import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@joe-p/sandbox-runtime";
import { parse, ParseEntry } from "shell-quote";
import crypto from "crypto";

export type ParentCommand = { command: string; id: string };

export function emptyRuntimeConfig(): SandboxRuntimeConfig {
  return {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      allowWrite: [],
      denyRead: [],
      denyWrite: [],
      allowRead: [],
    },
  };
}

export type CommandConfig = {
  /**
   * always deny a command when it matches this config.
   * It should be noted that when this is false the `preWrapHook` can still throw and prevent the command from running
   */
  alwayDenyWithMessage: string | false;
  /** srt runtime configuration for this specific command */
  runtimeConfig: SandboxRuntimeConfig;
  /** Callback that may conditionally approve or deny a command. If the function does not throw, it is considered an approval */
  approvalAssertion?: (
    command: string,
    parentCommand: ParentCommand,
  ) => Promise<void>;
};

/**
 * Initialize the sandbox and wait for the network to be ready.
 * Ideally we'd just pass configs to the wrap command, but it doesn't respect network settings
 */
async function initialize(config: SandboxRuntimeConfig) {
  await SandboxManager.initialize(config);
  await SandboxManager.waitForNetworkInitialization();
}

export type NetworkAndFsConfig = {
  filesystem: SandboxRuntimeConfig["filesystem"];
  network: SandboxRuntimeConfig["network"];
};

export class ScopedSandbox {
  scopedCommands: Record<string, CommandConfig> = {};

  constructor(
    public defaultConfig: CommandConfig,
    public mandatoryConfig: NetworkAndFsConfig,
  ) {}

  /**
   * Get the scoped config for the most specific match in scopedCommands
   *
   * For example, if scoped commands has ["npm", "npm add", "npm add --dev"]
   * and we call with "npm add --dev some-package", we use the config for "npm add --dev"
   */
  getCommandConfig(command: string): {
    config: CommandConfig;
    matchedKey?: string;
  } {
    const matches = Object.keys(this.scopedCommands).filter((key) => {
      return command === key || command.startsWith(key);
    });

    let config;
    let matchedKey = undefined;

    if (matches.length === 0) {
      config = this.defaultConfig;
    } else {
      matches.sort((a, b) => b.split(" ").length - a.split(" ").length);
      matchedKey = matches[0]!;

      config = this.scopedCommands[matchedKey]!;
    }

    return { config, matchedKey };
  }

  parseCommands(parsed: ParseEntry[]): string[] {
    const commands: string[] = [];
    let currentArgs: string[] = [];

    for (const token of parsed) {
      if (
        typeof token === "string" &&
        // Not an env var
        !/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(token)
      ) {
        currentArgs.push(token);
      } else if (typeof token === "object" && token !== null && "op" in token) {
        if (currentArgs.length > 0) {
          commands.push(currentArgs.join(" "));
          currentArgs = [];
        }
      }
    }

    if (currentArgs.length > 0) {
      commands.push(currentArgs.join(" "));
    }

    return commands;
  }

  async withWrappedCommand(
    command: string,
    cb: (wrappedCommand: string) => Promise<void>,
  ): Promise<void> {
    const parentCommand: ParentCommand = { command, id: crypto.randomUUID() };

    const commands = this.parseCommands(parse(command));

    let runtimeConfig = this.mandatoryConfig;
    for (const subCmd of commands) {
      const { config, matchedKey } = this.getCommandConfig(subCmd);

      if (config.alwayDenyWithMessage) {
        throw Error(
          `ScopedSandbox [${matchedKey}]: ${config.alwayDenyWithMessage}`,
        );
      }

      if (config.approvalAssertion) {
        await config.approvalAssertion(subCmd, parentCommand);
      }

      runtimeConfig = mergeWithConcatenation(
        runtimeConfig,
        this.getCommandConfig(subCmd).config.runtimeConfig,
      );
    }

    const initPromise = initialize(runtimeConfig);
    // After initialization, update config with the runtime config
    // This ensures command-specific configurations (like allowedDomains) are applied
    SandboxManager.updateConfig(runtimeConfig);

    const wrappedCmd = await SandboxManager.wrapWithSandbox(
      command,
      undefined,
      runtimeConfig,
    );

    await initPromise;
    await cb(wrappedCmd);
  }
}

export function mergeWithOverwrites(
  base: SandboxRuntimeConfig,
  overrides: Partial<NetworkAndFsConfig>,
): SandboxRuntimeConfig {
  const result: SandboxRuntimeConfig = {
    ...base,
    network: { ...base.network },
    filesystem: { ...base.filesystem },
  };

  if (overrides.network) {
    result.network = { ...result.network, ...overrides.network };
  }
  if (overrides.filesystem) {
    result.filesystem = { ...result.filesystem, ...overrides.filesystem };
  }

  return result;
}

export function mergeWithConcatenation(
  base: SandboxRuntimeConfig,
  overrides: Partial<NetworkAndFsConfig>,
): SandboxRuntimeConfig {
  const result: SandboxRuntimeConfig = {
    ...base,
    network: {
      ...base.network,
      allowedDomains: [
        ...(base.network.allowedDomains || []),
        ...(overrides.network?.allowedDomains || []),
      ],
      deniedDomains: [
        ...(base.network.deniedDomains || []),
        ...(overrides.network?.deniedDomains || []),
      ],
    },
    filesystem: {
      ...base.filesystem,
      skipMandatoryDenyPatterns:
        base.filesystem.skipMandatoryDenyPatterns ||
        overrides.filesystem?.skipMandatoryDenyPatterns,
      denyRead: [
        ...(base.filesystem.denyRead || []),
        ...(overrides.filesystem?.denyRead || []),
      ],
      denyWrite: [
        ...(base.filesystem.denyWrite || []),
        ...(overrides.filesystem?.denyWrite || []),
      ],
      denyReadAfterAllow: [
        ...(base.filesystem.denyReadAfterAllow || []),
        ...(overrides.filesystem?.denyReadAfterAllow || []),
      ],
      allowWrite: [
        ...(base.filesystem.allowWrite || []),
        ...(overrides.filesystem?.allowWrite || []),
      ],
      allowRead: [
        ...(base.filesystem.allowRead || []),
        ...(overrides.filesystem?.allowRead || []),
      ],
    },
  };

  return result;
}
