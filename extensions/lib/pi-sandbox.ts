import { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CommandConfig, ParentCommand, ScopedSandbox } from "./scoped-sandbox";

export type SandboxMode = "plan" | "build";

export class PiSandbox {
  public ctx?: ExtensionContext;
  private lastParentApproved?: string;
  private activeMode: SandboxMode;

  constructor(public sandboxes: { plan: ScopedSandbox; build: ScopedSandbox }) {
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
}
