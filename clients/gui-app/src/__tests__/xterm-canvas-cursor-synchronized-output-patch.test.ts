import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * `patches/@xterm%2Faddon-canvas@<version>.patch` gates the canvas cursor
 * layer's `_render` on DEC 2026 synchronized output. xterm applies that gate
 * in `RenderService.refreshRows` only; the canvas addon also paints the
 * cursor from its own blink timer and from the cursor-move animation frame,
 * which reach `_render` directly. Mid-frame the buffer cursor sits wherever
 * the TUI last painted, so those paints drew a ghost cursor at a random cell
 * of Codex's composer while its sparkle animation ran with the cursor shown.
 *
 * `patchedDependencies` is keyed by the exact package version, so a bump of
 * the addon silently drops the patch. This reads the installed file, not the
 * patch file, so what it certifies is the code the renderer loads.
 */
describe("@xterm/addon-canvas cursor layer patch", () => {
  it("skips the off-RenderService cursor paints while synchronized output is on", () => {
    const require = createRequire(import.meta.url);
    const source = readFileSync(require.resolve("@xterm/addon-canvas"), "utf8");
    expect(source).toContain("_render(e){/* Local patch (traycer):");
    expect(source).toContain(
      "if(this._coreService.decPrivateModes.synchronizedOutput)return;if(!this._coreService.isCursorInitialized||this._coreService.isCursorHidden)return void this._clearCursor();",
    );
  });
});
