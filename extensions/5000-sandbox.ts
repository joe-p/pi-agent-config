import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  emptyRuntimeConfig,
  MandatoryConfig,
  ScopedSandbox,
} from "./lib/scoped-sandbox";
import { PiSandbox } from "./lib/pi-sandbox";

/** Rules that are ALWAYS enforced */
const MANDATORY_CONFIG: MandatoryConfig = {
  network: {
    allowedDomains: [],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["~/", ".env", ".env.*", "*.pem", "*.key", ".pi"],
    allowRead: ["~/.config", "~/.local"],
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
  sandbox.addConfig("both", pm, {
    alwayDenyWithMessage: false,
    approvalAssertion: async (_, parentCommand) => {
      await sandbox.assertApproval(parentCommand);
    },
    runtimeConfig: {
      filesystem: {
        allowRead: ["."],
        allowWrite: [],
        denyRead: [],
        denyWrite: [],
      },
      network: {
        allowedDomains: ["npmjs.org", "registry.npmjs.org", "npm.jsr.io"],
        deniedDomains: [],
      },
    },
  });

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

const allowedGitCmds = ["diff", "grep", "log", "show", "status"];

sandbox.addConfig("both", "git", {
  runtimeConfig: emptyRuntimeConfig(),
  alwayDenyWithMessage: `This git command is not allowed. The allowed commands are ${allowedGitCmds}. As an agent, you should only use read-only git commands. If you think this is a mistake, inform the user and ask them to allow the sub-command you are trying to use`,
});

allowedGitCmds.forEach((c) => {
  sandbox.addConfig("both", `git ${c}`, {
    alwayDenyWithMessage: false,
    runtimeConfig: {
      ...emptyRuntimeConfig(),
      filesystem: {
        allowRead: ["~/.gitconfig"],
        allowWrite: [],
        denyRead: [],
        denyWrite: [],
      },
    },
  });
});

export default function (pi: ExtensionAPI) {
  sandbox.setupExtension(pi);
}
