import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const resolutionHarness = require("../run-resolution-matrix.cjs") as {
  createResolutionChildEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

describe("resolution child environment", () => {
  it("removes slotted dev identity before launching the no-slot harness", () => {
    const childEnv = resolutionHarness.createResolutionChildEnv({
      DEV_DESKTOP_SLOT: "traycer-spry-panda-a2acaa5e",
      TRAYCER_DESKTOP_DEV_DISPLAY_NAME: "Traycer Dev — spry-panda",
      PATH: "/usr/bin",
    });

    expect(childEnv.DEV_DESKTOP_SLOT).toBeUndefined();
    expect(childEnv.TRAYCER_DESKTOP_DEV_DISPLAY_NAME).toBeUndefined();
    expect(childEnv.PATH).toBe("/usr/bin");
  });
});
