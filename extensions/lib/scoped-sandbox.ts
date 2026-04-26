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
    denyRead: ["~/.ssh", "*.env", "*.pem", "*.key"],
    allowWrite: [],
    denyWrite: [],
  },
};

await SandboxManager.initialize(BASE_CONFIG);
await SandboxManager.waitForNetworkInitialization();

export type CommandConfig = {
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

  /**
   * Get the scoped config for the most specific match in scopedCommands
   *
   * For example, if scoped commands has ["npm", "npm add", "npm add --dev"]
   * and we call with "npm add --dev some-package", we use the config for "npm add --dev"
   */
  getCommandConfig(command: string): CommandConfig | undefined {
    const matches = Object.keys(this.scopedCommands).filter((key) => {
      return command === key || command.startsWith(key + " ");
    });

    if (matches.length === 0) {
      return undefined;
    }

    matches.sort((a, b) => b.split(" ").length - a.split(" ").length);
    return this.scopedCommands[matches[0]];
  }

  async getWrappedCommand(command: string): Promise<string> {
    const config = this.getCommandConfig(command);

    if (config === undefined) {
      return await SandboxManager.wrapWithSandbox(command);
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
