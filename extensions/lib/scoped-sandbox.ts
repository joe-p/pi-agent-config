import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { parse } from "shell-quote";
import crypto from "crypto";

const GLOBAL_CONFIG: SandboxRuntimeConfig = {
  network: {
    allowedDomains: [],
    deniedDomains: [],
  },
  filesystem: {
    allowRead: [],
    denyRead: ["*.env", "*.pem", "*.key"],
    allowWrite: [],
    denyWrite: [],
  },
};

export type ParentCommand = { command: string; id: string };

export type CommandConfig = {
  /**
   * always deny a command when it matches this config.
   * It should be noted that when this is false the `preWrapHook` can still throw and prevent the command from running
   */
  alwaysDeny: boolean;
  /** srt runtime configuration for this specific command */
  runtimeConfig?: Partial<SandboxRuntimeConfig>;
  /** Callback that may conditionally approve or deny a command. If the function does not throw, it is considered an approval */
  approvalAssertion?: (
    command: string,
    parentCommand: ParentCommand,
  ) => Promise<void>;
};

export class ScopedSandbox {
  scopedCommands: Record<string, CommandConfig> = {};

  static initialized: boolean = false;

  static async initialize(globalConfig?: SandboxRuntimeConfig) {
    if (ScopedSandbox.initialized) {
      throw Error("Initialize can only be called once!");
    }
    ScopedSandbox.initialized = true;

    await SandboxManager.initialize(globalConfig || GLOBAL_CONFIG);
    await SandboxManager.waitForNetworkInitialization();
  }

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
    return { config: this.scopedCommands[matches[0]], matchedKey: matches[0] };
  }

  async getWrappedCommand(command: string): Promise<string> {
    if (!ScopedSandbox.initialized) {
      throw Error("Must call ScopedSandbox.initialize first!");
    }

    const parentCommand: ParentCommand = { command, id: crypto.randomUUID() };

    // TODO: merge runtime configs
    const runtimeConfig =
      this.getCommandConfig(command)?.config.runtimeConfig ??
      this.defaultConfig.runtimeConfig;

    for (const e of parse(command)) {
      if (typeof e === "string") {
        const { config, matchedKey } = this.getCommandConfig(command) ?? {
          config: this.defaultConfig,
          matchedKey: "default",
        };

        if (config.alwaysDeny) {
          throw Error(
            `ScopedSandbox: ${command} has been blocked due to "alwaysDeny: true" in "${matchedKey}" configuration`,
          );
        }

        if (config.approvalAssertion) {
          await config.approvalAssertion(e, parentCommand);
        }
      }
    }

    return await SandboxManager.wrapWithSandbox(
      command,
      undefined,
      runtimeConfig,
    );
  }
}
