/*
 * Based on https://github.com/badlogic/pi-skills/tree/c7a11cfd441401eacd49b89d41c631e1b79ef6bc/brave-search
 */
import { Entry } from "@napi-rs/keyring";
import Type from "typebox";
import { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  domainIsAllowed,
  domainMatchesPattern,
  getEffectiveAllowedDomains,
  loadConfig,
  promptDomainBlock,
  applyDomainChoice,
} from "./sandbox";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const SERVICE = "pi-coding-agent";
const USERNAME = "skills/brave-search";

export const entry = new Entry(SERVICE, USERNAME);

async function fetchBraveResults(
  query: string,
  numResults?: number,
  freshness?: string,
) {
  const apiKey = entry.getPassword();
  if (apiKey === null) {
    throw Error("NO API KEY!");
  }

  const params = new URLSearchParams({
    q: query,
    count: Math.min(numResults ?? 5, 20).toString(),
    country: "US",
  });

  if (freshness) {
    params.append("freshness", freshness);
  }

  const url = `https://api.search.brave.com/res/v1/web/search?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HTTP ${response.status}: ${response.statusText}\n${errorText}`,
    );
  }

  const data = await response.json();

  const results: {
    title: string;
    link: string;
    snippet: string;
    age: string;
  }[] = [];

  // Extract web results
  if (data.web && data.web.results) {
    for (const result of data.web.results) {
      if (results.length >= (numResults ?? 5)) break;

      results.push({
        title: result.title || "",
        link: result.url || "",
        snippet: result.description || "",
        age: result.age || result.page_age || "",
      });
    }
  }

  return results;
}

function htmlToMarkdown(html: string) {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  turndown.use(gfm);
  turndown.addRule("removeEmptyLinks", {
    filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
    replacement: () => "",
  });
  return turndown
    .turndown(html)
    .replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
    .replace(/ +/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function webFetch(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw `HTTP ${response.status}: ${response.statusText}`;
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (article && article.content) {
    let content: string = "";
    if (article.title) {
      content += `# ${article.title}\n`;
    }
    content += htmlToMarkdown(article.content);
    return content;
  }

  // Fallback: try to extract main content
  const fallbackDoc = new JSDOM(html, { url });
  const body = fallbackDoc.window.document;
  body
    .querySelectorAll("script, style, noscript, nav, header, footer, aside")
    .forEach((el) => el.remove());

  const title = body.querySelector("title")?.textContent?.trim();
  const main =
    body.querySelector("main, article, [role='main'], .content, #content") ||
    body.body;

  let content: string = "";
  if (title) {
    content += `# ${title}\n`;
  }

  const text = main?.innerHTML || "";
  if (text.trim().length > 100) {
    content += htmlToMarkdown(text);
    return content;
  } else {
    throw Error("Could not extract readable content from this page.");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using Brave API",
    promptSnippet: `Use for searching the web with a given query. If using the date in your search be sure to use todays date: ${new Date().toLocaleDateString(
      "en-US",
      {
        month: "long", // "April"
        day: "numeric", // "24"
        year: "numeric", // "2026"
      },
    )}`,
    parameters: Type.Object({
      query: Type.String({
        description: "Search query",
      }),
      numResults: Type.Optional(
        Type.Number({ description: "Results per query (default: 5, max: 20)" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const results = await fetchBraveResults(params.query, params.numResults);
      return {
        content: [{ type: "text", text: JSON.stringify(results) }],
        details: results,
      };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch content as markdown from the web",
    promptSnippet: "Use for fetching content directly from a web page",
    parameters: Type.Object({
      url: Type.String({
        description: "Page url",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const results = await webFetch(params.url);
      return {
        content: [{ type: "text", text: results }],
        details: results,
      };
    },
  });

  // ── tool_call hook — network policy for web_fetch ────────────────────────────
  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    // Only intercept web_fetch tool calls
    if (event.toolName !== "web_fetch") return;

    const config = loadConfig(ctx.cwd);

    // Skip check if sandbox is disabled in config
    if (config.enabled === false) return;

    const urlString = (event.input as { url: string }).url;
    let domain: string;

    try {
      const url = new URL(urlString);
      domain = url.hostname;
    } catch {
      return {
        block: true,
        reason: `Invalid URL format: "${urlString}"`,
      };
    }

    const deniedDomains = config.network?.deniedDomains ?? [];

    // Check if domain is explicitly denied (hard block, no prompt)
    if (deniedDomains.some((p) => domainMatchesPattern(domain, p))) {
      return {
        block: true,
        reason: `Network access to "${domain}" is blocked (in deniedDomains).`,
      };
    }

    // Check if domain is allowed (includes session-allowed domains)
    const effectiveDomains = getEffectiveAllowedDomains(ctx.cwd);
    if (!domainIsAllowed(domain, effectiveDomains)) {
      // Prompt user for action (share session state with sandbox extension)
      const choice = await promptDomainBlock(ctx, domain);
      if (choice === "abort") {
        return {
          block: true,
          reason: `Network access to "${domain}" is blocked (not in allowedDomains). Use /sandbox to review your config.`,
        };
      }
      // Apply the choice - this adds to sessionAllowedDomains and config if needed
      await applyDomainChoice(choice, domain, ctx.cwd);
      // Domain is now allowed for this call - fall through to allow execution
    }
  });
}
