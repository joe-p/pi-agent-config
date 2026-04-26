import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

// Define your sandbox configuration
const BASE_CONFIG: SandboxRuntimeConfig = {
  network: {
    allowedDomains: [],
    deniedDomains: [],
  },
  filesystem: {
    allowRead: ["."],
    denyRead: ["~/.ssh", "*.env", "*.pem", "*.key"],
    allowWrite: [],
    denyWrite: [],
  },
};

export type CommandConfig = {
  allow: boolean;
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

  static async initialize(baseConfig?: SandboxRuntimeConfig) {
    await SandboxManager.initialize(baseConfig || BASE_CONFIG);
    await SandboxManager.waitForNetworkInitialization();

    return new ScopedSandbox();
  }

  private constructor() {}

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
    const match = this.getCommandConfig(command);

    if (match === undefined) {
      return await SandboxManager.wrapWithSandbox(command);
    }

    const { config, matchedKey } = match;

    if (!config.allow) {
      throw Error(
        `ScopedSandbox: ${command} has been blocked due to "allow: false" configuration for ${matchedKey}`,
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
