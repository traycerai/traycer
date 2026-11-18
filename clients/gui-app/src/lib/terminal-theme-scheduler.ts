import type { Terminal } from "@xterm/xterm";
import { appLogger } from "@/lib/logger";

/**
 * Coalesce xterm.js texture-atlas clears across all mounted terminals into a
 * single requestAnimationFrame so a theme/preset toggle that affects N
 * terminals doesn't fire N independent atlas rebuilds on the main thread.
 *
 * Keyed by the Terminal instance - multiple `scheduleAtlasClear` calls for
 * the same terminal within a frame collapse into one. Disposed addons are
 * tolerated: passing `null` (or a dropped reference) skips the clear and
 * lets xterm's DOM fallback re-render glyphs naturally. Renderer-agnostic:
 * both the canvas and WebGL addons expose `clearTextureAtlas()`.
 */
type AtlasClearable = { clearTextureAtlas(): void };

const pending = new Map<Terminal, AtlasClearable | null>();
let frameHandle: number | null = null;

function flush(): void {
  frameHandle = null;
  for (const [, addon] of pending) {
    if (addon === null) continue;
    try {
      addon.clearTextureAtlas();
    } catch (error) {
      appLogger.warn("[terminal-theme] texture atlas clear failed", {
        error: error instanceof Error ? error.name : typeof error,
      });
      // Addon was disposed mid-frame; xterm's own renderer takes over.
    }
  }
  pending.clear();
}

export function scheduleAtlasClear(
  terminal: Terminal,
  addon: AtlasClearable | null,
): void {
  pending.set(terminal, addon);
  if (frameHandle !== null) return;
  if (typeof window === "undefined") {
    flush();
    return;
  }
  frameHandle = window.requestAnimationFrame(flush);
}
