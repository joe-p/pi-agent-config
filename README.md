# joe-p's Pi Coding Agent

This repo contains the configuration for my [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) setup.

## Why Pi?

Before Pi I was a proud opencode user that often recommended it to many others. While I still think OpenCode is great software, I wanted something less opinionated out of the box so that I can have more control of tools that I use every day. OpenCode does have a plugin system, but it is not as powerful as pi's. The main functionality missing from opencode that is crticial for my Pi setup is that ability to prompt the user from a plugin.

## How I Use It

I do occasionally use the Pi TUI, but most of my usage is in neovim via my [pi-agent.nvim](https://github.com/joe-p/pi-agent.nvim) package.

## Extensions

### Sandbox: OS-Level Tool Sandboxing

[Sandbox](./extensions/5000-sandbox.ts) is the most important extension to my setup and is the main reason I use Pi as my daily driver. This extension uses [@joe-p/sandbox-runtime](https://github.com/joe-p/sandbox-runtime) (a fork of [@antrophic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)) which enables OS-level sandboxing for bash commands and uses an HTTP proxy to strictly control network access for bash commands. Additionally, sandbox rules are enforced for all the relevant tools:

- [web_fetch](./extensions/1000-web.ts)
- `read` (pi built-in)
- `edit` (pi built-in)

All the tools, including bash, support a prompting system so that the agent can prompt the user if it wants to access a denied resource.

There are similar extensions available for Pi, such as [the sandbox example](https://github.com/badlogic/pi-mono/blob/82ecc1300f1649388c346568c7a1b7978ec610d3/packages/coding-agent/examples/extensions/sandbox/index.ts) and [carderne/pi-sandbox](https://github.com/carderne/pi-sandbox). I built on top of these two sandbox extensions and added two main features: command-scoping and modality.

#### Modality

My sandbox has two rule sets: one for planning and one for building. As the names suggest, the plan mode restricts all writes while the build mode is used for commands that write files. This helps agents in plan mode stay on task and not modify any files by accident. Because the sandboxing is enforced at the OS level, this is a much stronger guarantee than a strongly worded plan-mode prompt and regex-based restrictions on tool calls.

#### Command Scoping

Most similar extensions apply one rule set to all commands globally or within a project. My sandbox extension, however, allows different rules for different commands. This allows for a greater level of isolation for most tools without breaking workflow critical tooling. For example, I don't like agents making any changes to git, but I still want to give the agent access to read-only commands. Thus, I first deny all git commands with a message to the agent. Then I can add exceptions for the commands I want and give them access to necessary git files.

```ts
const allowedGitCmds = ["diff", "grep", "log", "show", "status", "rev-parse"];

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
        allowRead: [
          ".", // git needs access to cwd
          walkBackUntilMatch(".", ".git")!,
          walkBackUntilMatch(".", ".gitignore")!,
        ],
        allowWrite: [],
        denyRead: [],
        denyWrite: [],
      },
    },
  });
});

```

### Keyring: Secure Storage of Secrets

The [keyring](./extensions/1000-keyring.ts) extension enables usage of the OS keyring (via `@napi-rs/keyring`) for storing secrets rather than using environment variables or CLI tools. Currently the extension is hardcoded to retrieve an OpenRouter API key, but the plan is to eventually expand it to be more modular with commands for adding/updating API keys.

### Web: Search & Fetch

The [web](./extensions/1000-web.ts) extension adds two tools to Pi: `web_search` and `web_fetch`. `web_search` uses the Brave API (with API key stored in keyring). Both tools respect the sandbox settings for the current mode.

### OpenRouter

The [OpenRouter](./extensions/1000-openrouter.ts) extension adds OpenRouter-specific [configuration file](./openrouter.json) for specifying request parameters such as provider order, provider fallback, data retention filtering, and data collection policy.

### TPS: Tokens Per Second

The [TPS](./extensions/tps-status.ts) is a very simple extension that reports the tokens per second for every LLM message
