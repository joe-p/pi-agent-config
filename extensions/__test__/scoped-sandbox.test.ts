import { beforeAll, describe, expect, it } from "vitest";
import { ScopedSandbox } from "../lib/scoped-sandbox";

describe("ScopedSandbox", () => {
  describe("getWrappedCommand", () => {
    let sb: ScopedSandbox;

    beforeAll(async () => {
      sb = await ScopedSandbox.initialize();

      sb.scopedCommands["npm"] = {
        allow: true,
        preWrapHook: async (cmd, _config) => {
          return cmd.replace("npm", "pnpm");
        },
      };

      sb.scopedCommands["shutdown"] = {
        allow: false,
      };
    });

    it("should return command from preWrapHook", async () => {
      const command = await sb.getWrappedCommand("npm install");
      expect(command).toMatch("pnpm install");
    });

    it("should throw when allow === false", async () => {
      await expect(sb.getWrappedCommand("shutdown")).rejects.toThrow(
        `ScopedSandbox: shutdown has been blocked due to "allow: false" configuration for shutdown`,
      );
    });
  });

  describe("getCommandConfig", () => {
    let sb: ScopedSandbox;

    beforeAll(async () => {
      sb = await ScopedSandbox.initialize();
      const addtestConfig = (command: string) => {
        sb.scopedCommands[command] = {
          allow: true,
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
        allow: true,
        preWrapHook: async (cmd, _config) => {
          return cmd.replace("npm", "pnpm");
        },
      };
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
