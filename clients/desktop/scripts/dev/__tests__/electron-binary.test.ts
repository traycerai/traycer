import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const electronBinary = require("../electron-binary.cjs") as {
  createDevBundleState: (options: {
    devBundleId: string;
    bundleDisplayName: string;
    electronVersion: string;
    sourceInfoPlistMtimeMs: number;
    sourceExecutableMtimeMs: number;
    iconMtimeMs: number;
  }) => string;
};

const bundleStateOptions = {
  devBundleId: "ai.traycer.desktop.dev.12345678",
  electronVersion: "42.0.0",
  sourceInfoPlistMtimeMs: 1,
  sourceExecutableMtimeMs: 2,
  iconMtimeMs: 3,
};

describe("dev Electron bundle state", () => {
  it("includes the display name so a renamed slot rebuilds its bundle", () => {
    const spryPandaState = electronBinary.createDevBundleState({
      ...bundleStateOptions,
      bundleDisplayName: "Traycer Dev — spry-panda",
    });
    const amberLionState = electronBinary.createDevBundleState({
      ...bundleStateOptions,
      bundleDisplayName: "Traycer Dev — amber-lion",
    });

    expect(spryPandaState).not.toBe(amberLionState);
    expect(JSON.parse(spryPandaState)).toMatchObject({
      bundleDisplayName: "Traycer Dev — spry-panda",
    });
  });
});
