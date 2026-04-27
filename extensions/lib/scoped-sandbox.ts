import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

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

export type CommandConfig = {
  /**
   * always deny a command when it matches this config.
   * It should be noted that when this is false the `preWrapHook` can still throw and prevent the command from running
   */
  alwaysDeny: boolean;
  /** srt runtime configuration for this specific command */
  runtimeConfig?: Partial<SandboxRuntimeConfig>;
  /** Callback that may modify the runtime config (modified in place) or the command wrapped (returned) */
  preWrapHook?: (
    command: string,
    config: Partial<SandboxRuntimeConfig>,
  ) => Promise<string>;
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

    const { config, matchedKey } = this.getCommandConfig(command) ?? {
      config: this.defaultConfig,
      matchedKey: "default",
    };

    if (config.alwaysDeny) {
      throw Error(
        `ScopedSandbox: ${command} has been blocked due to "alwaysDeny: true" in "${matchedKey}" configuration`,
      );
    }

    const runtimeConfig = config.runtimeConfig ?? {};

    const cmdToWrap = config.preWrapHook
      ? await config.preWrapHook(command, runtimeConfig)
      : command;

    return await SandboxManager.wrapWithSandbox(
      cmdToWrap,
      undefined,
      runtimeConfig,
    );
  }
}
