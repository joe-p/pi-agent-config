import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@joe-p/sandbox-runtime";
import { parse } from "shell-quote";
import crypto from "crypto";

export type ParentCommand = { command: string; id: string };

export function emptyRuntimeConfig(): SandboxRuntimeConfig {
  return {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      allowWrite: [],
      denyRead: ["/Users/"],
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

export class ScopedSandbox {
  scopedCommands: Record<string, CommandConfig> = {};

  constructor(public defaultConfig: CommandConfig) {}

  /**
   * Get the scoped config for the most specific match in scopedCommands
   *
   * For example, if scoped commands has ["npm", "npm add", "npm add --dev"]
   * and we call with "npm add --dev some-package", we use the config for "npm add --dev"
   */
  getCommandConfig(command: string):
    | {
        config: CommandConfig;
        matchedKey: string;
      }
    | undefined {
    const matches = Object.keys(this.scopedCommands).filter((key) => {
      return command === key || command.startsWith(key + " ");
    });

    if (matches.length === 0) {
      return undefined;
    }

    matches.sort((a, b) => b.split(" ").length - a.split(" ").length);
    const matchedKey = matches[0]!;
    return { config: this.scopedCommands[matchedKey]!, matchedKey };
  }

  // TODO: put this behind mutex
  async withWrappedCommand(
    command: string,
    cb: (wrappedCommand: string) => Promise<void>,
  ): Promise<void> {
    const parentCommand: ParentCommand = { command, id: crypto.randomUUID() };

    // TODO: merge runtime configs
    const runtimeConfig =
      this.getCommandConfig(command)?.config.runtimeConfig ??
      this.defaultConfig.runtimeConfig;

    if (runtimeConfig.filesystem.denyRead.includes("/Users/"))
      runtimeConfig.filesystem.denyRead.push("/Users/");

    const initPromise = initialize(runtimeConfig);
    // After initialization, update config with the runtime config
    // This ensures command-specific configurations (like allowedDomains) are applied
    SandboxManager.updateConfig(runtimeConfig);

    for (const e of parse(command)) {
      if (typeof e === "string") {
        const { config, matchedKey } = this.getCommandConfig(command) ?? {
          config: this.defaultConfig,
          matchedKey: "default",
        };

        if (config.alwayDenyWithMessage) {
          throw Error(
            `ScopedSandbox [${matchedKey}]: ${config.alwayDenyWithMessage}`,
          );
        }

        if (config.approvalAssertion) {
          await config.approvalAssertion(e, parentCommand);
        }
      }
    }

    const wrappedCmd = await SandboxManager.wrapWithSandbox(
      command,
      undefined,
      runtimeConfig,
    );

    await initPromise;
    await cb(wrappedCmd);
  }
}
