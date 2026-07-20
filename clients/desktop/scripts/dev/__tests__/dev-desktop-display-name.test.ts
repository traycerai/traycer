import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const devDesktopDisplayName = require("../dev-desktop-display-name.cjs") as {
  resolveDevDesktopDisplayName: (env: NodeJS.ProcessEnv) => string | null;
};

describe("resolveDevDesktopDisplayName", () => {
  it("uses the readable worktree name from the generated slot", () => {
    expect(
      devDesktopDisplayName.resolveDevDesktopDisplayName({
        DEV_DESKTOP_SLOT: "traycer-spry-panda-a2acaa5e",
      }),
    ).toBe("Traycer Dev — spry-panda");
  });

  it("strips the generated hash without requiring a traycer prefix", () => {
    expect(
      devDesktopDisplayName.resolveDevDesktopDisplayName({
        DEV_DESKTOP_SLOT: "fix-macos-ctrl-chord-passthrough-e1d873c7",
      }),
    ).toBe("Traycer Dev — fix-macos-ctrl-chord-passthrough");
  });

  it("keeps the current Electron naming when no slot is active", () => {
    expect(devDesktopDisplayName.resolveDevDesktopDisplayName({})).toBeNull();
  });
});
