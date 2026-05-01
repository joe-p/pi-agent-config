/**
 * Tokens Per Second (TPS) Status Extension
 *
 * Shows average TPS in the footer status bar.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const EXT_ID = "tps";

  let lastTps = 0;
  let isActive = false;
  let startTime = 0;
  let charCount = 0;

  function updateStatus(ctx: ExtensionContext) {
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed < 0.05) return;

    const tokens = isActive ? Math.floor(charCount / 4) : lastTps;
    const tps = isActive ? Math.round(tokens / elapsed) : lastTps;
    const theme = ctx.ui.theme;

    ctx.ui.setStatus(
      EXT_ID,
      `${theme.fg("text", `${tps}`)}${theme.fg("muted", " tok/s")}`,
    );
  }

  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return;
    isActive = true;
    startTime = Date.now();
    charCount = 0;
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant" || !isActive) return;

    isActive = false;
    const msg = event.message;
    const elapsed = (Date.now() - startTime) / 1000;

    if (msg.usage && msg.usage.output > 0 && elapsed > 0) {
      lastTps = Math.round(msg.usage.output / elapsed);
      updateStatus(ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    isActive = false;
    lastTps = 0;
  });
}
