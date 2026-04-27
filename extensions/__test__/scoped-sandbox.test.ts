import { beforeAll, describe, expect, it, vi } from "vitest";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { emptyRuntimeConfig, ScopedSandbox } from "../lib/scoped-sandbox";

describe("ScopedSandbox", () => {
  describe("withWrappedCommand", () => {
    let sb: ScopedSandbox;

    beforeAll(async () => {
      sb = new ScopedSandbox({
        alwayDenyWithMessage: false,
        runtimeConfig: emptyRuntimeConfig(),
      });

      sb.scopedCommands["npm"] = {
        alwayDenyWithMessage: false,
        runtimeConfig: emptyRuntimeConfig(),
      };

      sb.scopedCommands["shutdown"] = {
        runtimeConfig: emptyRuntimeConfig(),
        alwayDenyWithMessage:
          "shutdown has been blocked due to alwaysDeny configuration",
      };
    });

    it("should throw when allow === false", async () => {
      await expect(
        sb.withWrappedCommand("shutdown", async () => {}),
      ).rejects.toThrow(
        `ScopedSandbox [shutdown]: shutdown has been blocked due to alwaysDeny configuration`,
      );
    });

    it("should use default config when no scoped command matches", async () => {
      const freshSb = new ScopedSandbox({
        alwayDenyWithMessage: false,
        runtimeConfig: emptyRuntimeConfig(),
      });
      await freshSb.withWrappedCommand("echo hello", async (command) => {
        expect(command).toMatch("echo hello");
      });
    });

    it("should throw with default config when alwayDenyWithMessage is set and no scoped match", async () => {
      const freshSb = new ScopedSandbox({
        runtimeConfig: emptyRuntimeConfig(),
        alwayDenyWithMessage:
          "echo hello has been blocked due to alwaysDeny configuration",
      });
      await expect(
        freshSb.withWrappedCommand("echo hello", async () => {}),
      ).rejects.toThrow(
        `ScopedSandbox [default]: echo hello has been blocked due to alwaysDeny configuration`,
      );
    });

    it("should pass runtimeConfig to wrapWithSandbox", async () => {
      const freshSb = new ScopedSandbox({
        alwayDenyWithMessage: false,
        runtimeConfig: emptyRuntimeConfig(),
      });

      const runtimeConfig = emptyRuntimeConfig();
      runtimeConfig.filesystem.allowRead = ["/tmp"];

      freshSb.scopedCommands["test"] = {
        alwayDenyWithMessage: false,
        runtimeConfig,
      };
      const spy = vi
        .spyOn(SandboxManager, "wrapWithSandbox")
        .mockResolvedValue("wrapped");
      try {
        await freshSb.withWrappedCommand("test cmd", async () => {});
        expect(spy).toHaveBeenCalledWith("test cmd", undefined, {
          ...emptyRuntimeConfig(),
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

    it("should block curl to github.com without allowedDomains", async () => {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);

      const freshSb = new ScopedSandbox({
        alwayDenyWithMessage: false,
        runtimeConfig: emptyRuntimeConfig(),
      });

      await freshSb.withWrappedCommand(
        "curl -s -o /dev/null -w '%{http_code}' https://github.com",
        async (wrappedCmd) => {
          // curl should fail to connect without network permissions
          await expect(
            execAsync(wrappedCmd, { timeout: 10000 }),
          ).rejects.toThrow();
        },
      );
    }, 15000);

    it("should allow curl to github.com with command-specific allowedDomains config", async () => {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);

      const freshSb = new ScopedSandbox({
        alwayDenyWithMessage: false,
        runtimeConfig: emptyRuntimeConfig(),
      });

      // Add command-specific config that allows github.com
      freshSb.scopedCommands["curl"] = {
        alwayDenyWithMessage: false,
        runtimeConfig: {
          enableWeakerNetworkIsolation: true,
          filesystem: {
            allowRead: [],
            denyRead: [],
            allowWrite: [],
            denyWrite: [],
          },
          network: {
            deniedDomains: [],
            allowedDomains: ["github.com"],
          },
        },
      };

      await freshSb.withWrappedCommand(
        "curl -s -o /dev/null -w '%{http_code}' https://github.com",
        async (wrappedCmd) => {
          const result = await execAsync(wrappedCmd, { timeout: 10000 });
          // Should get HTTP 200 status code
          expect(result.stdout.trim()).toBe("200");
        },
      );
    }, 15000);
  });

  describe("getCommandConfig", () => {
    let sb: ScopedSandbox;

    beforeAll(async () => {
      sb = new ScopedSandbox({
        alwayDenyWithMessage: false,
        runtimeConfig: emptyRuntimeConfig(),
      });

      const addtestConfig = (command: string) => {
        sb.scopedCommands[command] = {
          alwayDenyWithMessage:
            "command has been blocked due to alwaysDeny configuration",
          runtimeConfig: {
            ...emptyRuntimeConfig(),
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
        runtimeConfig: emptyRuntimeConfig(),
        alwayDenyWithMessage:
          "command has been blocked due to alwaysDeny configuration",
      };
    });

    it("should return undefined when no command matches", () => {
      expect(sb.getCommandConfig("totally-unknown")).toBeUndefined();
    });

    it("should not match partial words", () => {
      const freshSb = new ScopedSandbox({
        alwayDenyWithMessage: false,
        runtimeConfig: emptyRuntimeConfig(),
      });
      freshSb.scopedCommands["npm"] = {
        runtimeConfig: emptyRuntimeConfig(),
        alwayDenyWithMessage:
          "npm has been blocked due to alwaysDeny configuration",
      };
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
