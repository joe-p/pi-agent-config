import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Entry } from "@napi-rs/keyring";

const SERVICE = "pi-coding-agent";

export async function getOrPromptForKey(
  ctx: ExtensionContext,
  username: string,
) {
  const entry = new Entry(SERVICE, username);

  if (!entry.getPassword()) {
    const userInput = await ctx.ui.input(`Set ${username} Keyring Secret`);

    if (userInput === undefined) {
      ctx.ui.notify("API key not provided!", "error");
      return null;
    }

    entry.setPassword(userInput);
  }

  return entry.getPassword();
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const provider = "openrouter";

    const providerKey = "openrouter/default";

    const apiKeyFromKeyring = await getOrPromptForKey(ctx, providerKey);

    if (apiKeyFromKeyring === null) {
      ctx.ui.notify(`Could not get ${providerKey} API key from keyring`);
      return;
    }

    ctx.modelRegistry.authStorage.setRuntimeApiKey(provider, apiKeyFromKeyring);
  });
}
