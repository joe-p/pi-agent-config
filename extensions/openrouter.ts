import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * OpenRouter provider preferences configuration.
 * Maps model IDs to provider objects that are injected directly into the request.
 *
 * Example config:
 * {
 *   "anthropic/claude-sonnet-4": {
 *     "order": ["Anthropic", "AWS Bedrock", "Google Cloud"],
 *     "ignore": ["Fireworks"]
 *   },
 *   "meta-llama/llama-3.3-70b-instruct": {
 *     "order": ["Together", "DeepInfra"],
 *     "only": ["Together", "DeepInfra", "Fireworks"]
 *   }
 * }
 */
interface ProviderObject {
  order?: string[];
  allow_fallbacks?: boolean;
}

type ProviderPreferencesConfig = Record<string, ProviderObject>;

const CONFIG_FILENAME = "openrouter.json";

function getConfigPath(): string {
  const piDir =
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(piDir, CONFIG_FILENAME);
}

function loadConfig(configPath: string): ProviderPreferencesConfig | null {
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, "utf8");
    const config = JSON.parse(content) as ProviderPreferencesConfig;

    // Basic validation
    for (const [modelId, provider] of Object.entries(config)) {
      if (typeof provider !== "object" || provider === null) {
        console.error(
          `[OpenRouter Provider Prefs] Invalid provider config for ${modelId}: must be an object`,
          "error",
        );
        return null;
      }
    }

    return config;
  } catch (error) {
    console.error(
      `[OpenRouter Provider Prefs] Failed to load config: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function normalizeModelId(modelId: string): string {
  // Strip openrouter/ prefix for lookup
  if (modelId.startsWith("openrouter/")) {
    return modelId.slice("openrouter/".length);
  }
  return modelId;
}

function isOpenRouterRequest(modelId: string | undefined): boolean {
  if (!modelId) return false;
  // Check if model ID contains openrouter (either as prefix or in the path)
  return modelId.startsWith("openrouter/") || modelId.includes("/");
}

export default function (pi: ExtensionAPI) {
  const configPath = getConfigPath();
  let config: ProviderPreferencesConfig | null = loadConfig(configPath);

  // Log loaded config status on startup
  if (config === null && existsSync(configPath)) {
    console.error(
      `[OpenRouter Provider Prefs] Config file exists but failed to load: ${configPath}`,
    );
  }

  // Intercept requests to inject provider preferences
  pi.on("before_provider_request", (event, ctx) => {
    // Get model ID from payload
    const payload = event.payload as { model?: string };
    const modelId = payload.model;

    if (!isOpenRouterRequest(modelId)) {
      return;
    }

    // Normalize model ID for lookup (strip openrouter/ prefix)
    const lookupKey = normalizeModelId(modelId!);

    // Try exact match first, then try the original model ID
    let providerConfig = config?.[lookupKey] ?? config?.[modelId!];

    if (!providerConfig) {
      return;
    }

    // Inject provider preferences into payload
    return {
      ...(event.payload as any),

      provider: providerConfig,
    };
  });

  // Register reload command
  pi.registerCommand("openrouter-providers", {
    description: "Manage OpenRouter provider preferences",
    handler: async (args, ctx) => {
      const subcommand = args.trim().toLowerCase();

      if (subcommand === "reload" || subcommand === "r") {
        const newConfig = loadConfig(ctx, configPath);
        if (newConfig) {
          config = newConfig;
          const modelCount = Object.keys(config).length;
          ctx.ui.notify(
            `Reloaded preferences for ${modelCount} model(s)`,
            "info",
          );
        } else {
          ctx.ui.notify("Failed to reload config", "error");
        }
        return;
      }

      if (subcommand === "show" || subcommand === "s" || !subcommand) {
        if (!config || Object.keys(config).length === 0) {
          ctx.ui.notify(
            `No preferences configured. Create ${CONFIG_FILENAME}`,
            "info",
          );
          return;
        }

        const lines: string[] = [];
        for (const [modelId, provider] of Object.entries(config)) {
          lines.push(`${modelId}:`);
          if (provider.order) {
            lines.push(`  order: ${provider.order.join(", ")}`);
          }
          if (provider.allow_fallbacks) {
            lines.push(`  only: ${provider.allow_fallbacks}`);
          }
        }

        // Display in a widget
        ctx.ui.setWidget("openrouter-prefs", lines);
        ctx.ui.notify("Provider preferences displayed above editor", "info");
        return;
      }

      if (subcommand === "path" || subcommand === "p") {
        ctx.ui.notify(`Config: ${configPath}`, "info");
        return;
      }

      ctx.ui.notify("Usage: /openrouter-providers [reload|show|path]", "info");
    },
  });
}
