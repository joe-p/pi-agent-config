import { beforeAll, describe, expect, it, vi } from "vitest";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { ScopedSandbox } from "../lib/scoped-sandbox";

await ScopedSandbox.initialize();

describe("ScopedSandbox", () => {
  describe("getWrappedCommand", () => {
    let sb: ScopedSandbox;

    beforeAll(async () => {
      sb = new ScopedSandbox({ alwaysDeny: false });

      sb.scopedCommands["npm"] = {
        alwaysDeny: false,
        preWrapHook: async (cmd) => {
          return cmd.replace("npm", "pnpm");
        },
      };

      sb.scopedCommands["shutdown"] = {
        alwaysDeny: true,
      };
    });

    it("should return command from preWrapHook", async () => {
      const command = await sb.getWrappedCommand("npm install");
      expect(command).toMatch("pnpm install");
    });

    it("should throw when allow === false", async () => {
      await expect(sb.getWrappedCommand("shutdown")).rejects.toThrow(
        `ScopedSandbox: shutdown has been blocked due to "alwaysDeny: true" in "shutdown" configuration`,
      );
    });

    it("should throw when ScopedSandbox is not initialized", async () => {
      const original = ScopedSandbox.initialized;
      ScopedSandbox.initialized = false;
      const freshSb = new ScopedSandbox({ alwaysDeny: false });
      try {
        await expect(freshSb.getWrappedCommand("echo hi")).rejects.toThrow(
          "Must call ScopedSandbox.initialize first!",
        );
      } finally {
        ScopedSandbox.initialized = original;
      }
    });

    it("should use default config when no scoped command matches", async () => {
      const freshSb = new ScopedSandbox({ alwaysDeny: false });
      const command = await freshSb.getWrappedCommand("echo hello");
      expect(command).toMatch("echo hello");
    });

    it("should throw with default config when alwaysDeny is true and no scoped match", async () => {
      const freshSb = new ScopedSandbox({ alwaysDeny: true });
      await expect(freshSb.getWrappedCommand("echo hello")).rejects.toThrow(
        `ScopedSandbox: echo hello has been blocked due to "alwaysDeny: true" in "default" configuration`,
      );
    });

    it("should pass preWrapHook result to wrapWithSandbox", async () => {
      const freshSb = new ScopedSandbox({ alwaysDeny: false });
      freshSb.scopedCommands["npm"] = {
        alwaysDeny: false,
        preWrapHook: async (cmd) => cmd.replace("npm", "pnpm"),
      };
      const spy = vi
        .spyOn(SandboxManager, "wrapWithSandbox")
        .mockResolvedValue("wrapped");
      try {
        await freshSb.getWrappedCommand("npm install");
        expect(spy).toHaveBeenCalledWith("pnpm install", undefined, undefined);
      } finally {
        spy.mockRestore();
      }
    });

    it("should pass runtimeConfig to wrapWithSandbox", async () => {
      const freshSb = new ScopedSandbox({ alwaysDeny: false });
      freshSb.scopedCommands["test"] = {
        alwaysDeny: false,
        runtimeConfig: {
          filesystem: {
            allowRead: ["/tmp"],
            denyRead: [],
            allowWrite: [],
            denyWrite: [],
          },
        },
      };
      const spy = vi
        .spyOn(SandboxManager, "wrapWithSandbox")
        .mockResolvedValue("wrapped");
      try {
        await freshSb.getWrappedCommand("test cmd");
        expect(spy).toHaveBeenCalledWith("test cmd", undefined, {
          filesystem: {
            allowRead: ["/tmp"],
            denyRead: [],
            allowWrite: [],
            denyWrite: [],
          },
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("getCommandConfig", () => {
    let sb: ScopedSandbox;

    beforeAll(async () => {
      sb = new ScopedSandbox({ alwaysDeny: false });
      const addtestConfig = (command: string) => {
        sb.scopedCommands[command] = {
          alwaysDeny: true,
          runtimeConfig: {
            filesystem: {
              allowRead: [command],
              denyRead: [],
              allowWrite: [],
              denyWrite: [],
            },
          },
        };
      };

      addtestConfig("pnpm");
      addtestConfig("pnpm add");
      addtestConfig("pnpm add -D");
      sb.scopedCommands["npm"] = {
        alwaysDeny: true,
        preWrapHook: async (cmd) => {
          return cmd.replace("npm", "pnpm");
        },
      };
    });

    it("should return undefined when no command matches", () => {
      expect(sb.getCommandConfig("totally-unknown")).toBeUndefined();
    });

    it("should not match partial words", () => {
      const freshSb = new ScopedSandbox({ alwaysDeny: false });
      freshSb.scopedCommands["npm"] = { alwaysDeny: true };
      expect(freshSb.getCommandConfig("npx install")).toBeUndefined();
    });

    it("should match single command", () => {
      expect(sb.getCommandConfig("pnpm")?.config).toEqual(
        sb.scopedCommands["pnpm"],
      );
    });

    it("should match single command with non-match subcommand", () => {
      expect(sb.getCommandConfig("pnpm update")?.config).toEqual(
        sb.scopedCommands["pnpm"],
      );
    });

    it("should match sub command", () => {
      expect(sb.getCommandConfig("pnpm add")?.config).toEqual(
        sb.scopedCommands["pnpm add"],
      );
    });

    it("should match sub command with non-match subcommand", () => {
      expect(sb.getCommandConfig("pnpm add some-package")?.config).toEqual(
        sb.scopedCommands["pnpm add"],
      );
    });

    it("should match mutliple sub commands", () => {
      expect(sb.getCommandConfig("pnpm add -D")?.config).toEqual(
        sb.scopedCommands["pnpm add -D"],
      );
    });

    it("should match mutliple sub commands with non-matching subcommand", () => {
      expect(sb.getCommandConfig("pnpm add -D some-package")?.config).toEqual(
        sb.scopedCommands["pnpm add -D"],
      );
    });
  });
});
