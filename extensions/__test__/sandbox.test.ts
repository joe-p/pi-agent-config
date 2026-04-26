import { beforeAll, describe, expect, it } from "vitest";
import { ScopedSandbox } from "../lib/scoped-sandbox";

describe("ScopedSandbox", () => {
  describe("getWrappedCommand", () => {
    let sb: ScopedSandbox;

    beforeAll(() => {
      sb = new ScopedSandbox();

      sb.scopedCommands["npm"] = {
        preWrapHook: async (cmd, _config) => {
          return cmd.replace("npm", "pnpm");
        },
      };
    });

    it("should return command from preWrapHook", async () => {
      const command = await sb.getWrappedCommand("npm install");
      expect(command).toMatch("pnpm install");
    });
  });

  describe("getCommandConfig", () => {
    let sb: ScopedSandbox;

    beforeAll(() => {
      sb = new ScopedSandbox();
      const addtestConfig = (command: string) => {
        sb.scopedCommands[command] = {
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
        preWrapHook: async (cmd, _config) => {
          return cmd.replace("npm", "pnpm");
        },
      };
    });

    it("should match single command", () => {
      expect(sb.getCommandConfig("pnpm")).toEqual(sb.scopedCommands["pnpm"]);
    });

    it("should match single command with non-match subcommand", () => {
      expect(sb.getCommandConfig("pnpm update")).toEqual(
        sb.scopedCommands["pnpm"],
      );
    });

    it("should match sub command", () => {
      expect(sb.getCommandConfig("pnpm add")).toEqual(
        sb.scopedCommands["pnpm add"],
      );
    });

    it("should match sub command with non-match subcommand", () => {
      expect(sb.getCommandConfig("pnpm add some-package")).toEqual(
        sb.scopedCommands["pnpm add"],
      );
    });

    it("should match mutliple sub commands", () => {
      expect(sb.getCommandConfig("pnpm add -D")).toEqual(
        sb.scopedCommands["pnpm add -D"],
      );
    });

    it("should match mutliple sub commands with non-matching subcommand", () => {
      expect(sb.getCommandConfig("pnpm add -D some-package")).toEqual(
        sb.scopedCommands["pnpm add -D"],
      );
    });
  });
});
