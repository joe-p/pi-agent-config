import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Entry } from "@napi-rs/keyring";

const SERVICE = "pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const provider = "openrouter";
    const currentKey = await ctx.modelRegistry.authStorage.getApiKey(provider);

    const providerKey = "openrouter/default";

    const entry = new Entry(SERVICE, providerKey);

    if (!currentKey && !entry.getPassword()) {
      const userInput = await ctx.ui.input(`${provider} API key`);

      if (userInput === undefined) {
        ctx.ui.notify("API key not provided!", "error");
        return;
      }

      entry.setPassword(userInput);
    }

    const apiKeyFromKeyring = entry.getPassword();

    if (apiKeyFromKeyring === null) {
      ctx.ui.notify(`Could not get ${providerKey} API key from keyring`);
      return;
    }

    ctx.modelRegistry.authStorage.setRuntimeApiKey(provider, apiKeyFromKeyring);
  });
}
