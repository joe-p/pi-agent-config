import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  CommandConfig,
  emptyRuntimeConfig,
  NetworkAndFsConfig,
  ScopedSandbox,
} from "./lib/scoped-sandbox";
import { PiSandbox, walkBackUntilMatch } from "./lib/pi-sandbox";

/** Rules that are ALWAYS enforced */
const MANDATORY_CONFIG: NetworkAndFsConfig = {
  network: {
    allowedDomains: [],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["~/"],
    allowRead: ["~/.config", "~/.local", "~/.gitconfig"],
    denyReadAfterAllow: [".env", ".env.*", "*.pem", "*.key", ".pi"],
    allowWrite: [],
    denyWrite: [".git"],
  },
};

const sandboxes = {
  build: new ScopedSandbox(
    {
      alwayDenyWithMessage: false,
      runtimeConfig: {
        ...emptyRuntimeConfig(),
        filesystem: {
          allowRead: ["."],
          denyRead: [],
          allowWrite: [".", "/tmp"],
          denyWrite: [],
        },
      },
    },
    MANDATORY_CONFIG,
  ),
  plan: new ScopedSandbox(
    {
      alwayDenyWithMessage: false,
      runtimeConfig: {
        ...emptyRuntimeConfig(),
        filesystem: {
          allowRead: ["."],
          denyRead: [],
          denyWrite: [],
          allowWrite: [],
        },
      },
    },
    MANDATORY_CONFIG,
  ),
};

export const sandbox = new PiSandbox(sandboxes);

const jsPackageManagers = ["npm", "deno", "bun"];
const jsInstallSubCommands = ["i", "add", "install"];

jsPackageManagers.forEach((pm) => {
  // In both plan mode and build mode allow pnpm to read files and access the registry
  // The network access is primarily useful for letting the agent run audit commands in plan mode
  sandbox.addConfig("both", pm, {
    alwayDenyWithMessage: false,
    runtimeConfig: {
      filesystem: {
        allowRead: ["."],
        allowWrite: ["node_modules/.vite-temp"],
        denyRead: [],
        denyWrite: [],
      },
      network: {
        allowedDomains: ["npmjs.org", "registry.npmjs.org", "npm.jsr.io"],
        deniedDomains: [],
      },
    },
  });

  // In build mode, allow writing and network access to the registry
  jsInstallSubCommands.forEach((c) => {
    sandbox.addConfig("build", `${pm} ${c}`, {
      alwayDenyWithMessage: false,
      approvalAssertion: async (_, parentCommand) => {
        await sandbox.assertApproval(parentCommand);
      },
      runtimeConfig: {
        filesystem: {
          // SRT has protections against specific directories/files such as .vscode, .gitmodules
          // This is problematic for npm (and likely other package managers) because some packages
          // include these directories in their bundle. We are still explicitly blocking writes to
          // .git so we should be safe.
          skipMandatoryDenyPatterns: true,

          // TODO: further restrict to only allow read/writes on package.json, node_modules, and lock file.
          // This will require logic to find the package.json and/or node_modules
          allowRead: ["."],
          allowWrite: ["."],

          denyRead: [],
          denyWrite: [],
        },
        network: {
          allowedDomains: ["npmjs.org", "registry.npmjs.org", "npm.jsr.io"],
          deniedDomains: [],
        },
      },
    });
  });
});

const allowedGitCmds = ["diff", "grep", "log", "show", "status", "rev-parse"];

sandbox.addConfig("both", "git", {
  runtimeConfig: emptyRuntimeConfig(),
  alwayDenyWithMessage: `This git command is not allowed. The allowed commands are ${allowedGitCmds}. As an agent, you should only use read-only git commands. If you think this is a mistake, inform the user and ask them to allow the sub-command you are trying to use`,
});

allowedGitCmds.forEach((c) => {
  const config: CommandConfig = {
    alwayDenyWithMessage: false,
    runtimeConfig: {
      ...emptyRuntimeConfig(),
      filesystem: {
        allowRead: [
          ".",
          walkBackUntilMatch(".", ".git")!,
          walkBackUntilMatch(".", ".gitignore")!,
        ],
        allowWrite: [],
        denyRead: [],
        denyWrite: [],
      },
    },
  };

  sandbox.addConfig("both", `git ${c}`, config);
});

export default function (pi: ExtensionAPI) {
  sandbox.setupExtension(pi);
}
