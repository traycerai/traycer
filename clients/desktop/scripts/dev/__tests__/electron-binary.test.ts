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
  decideDisableChromiumSandbox: (options: {
    platform: NodeJS.Platform;
    apparmorRestrictsUserns: boolean;
    usernsCloneDisabled: boolean;
    sandboxHelperStat: { uid: number; mode: number } | null;
  }) => boolean;
  decideOzonePlatform: (options: {
    platform: NodeJS.Platform;
    ozonePlatformOverride: string | undefined;
    electronOzoneHint: string | undefined;
    display: string | undefined;
    waylandDisplay: string | undefined;
  }) => string | null;
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

describe("decideDisableChromiumSandbox", () => {
  const linuxDefaults = {
    platform: "linux" as const,
    apparmorRestrictsUserns: false,
    usernsCloneDisabled: false,
    sandboxHelperStat: null,
  };

  it("never disables off Linux", () => {
    expect(
      electronBinary.decideDisableChromiumSandbox({
        ...linuxDefaults,
        platform: "darwin",
        apparmorRestrictsUserns: true,
      }),
    ).toBe(false);
  });

  it("keeps the sandbox when unprivileged userns is available", () => {
    expect(electronBinary.decideDisableChromiumSandbox(linuxDefaults)).toBe(
      false,
    );
  });

  it("disables when userns is restricted and the helper is not setuid root", () => {
    expect(
      electronBinary.decideDisableChromiumSandbox({
        ...linuxDefaults,
        apparmorRestrictsUserns: true,
        // The node_modules download: owned by the developer, plain 0755.
        sandboxHelperStat: { uid: 1000, mode: 0o100755 },
      }),
    ).toBe(true);
  });

  it("disables when userns is restricted and the helper is missing entirely", () => {
    expect(
      electronBinary.decideDisableChromiumSandbox({
        ...linuxDefaults,
        usernsCloneDisabled: true,
        sandboxHelperStat: null,
      }),
    ).toBe(true);
  });

  it("keeps the sandbox when a root-owned setuid helper can take over", () => {
    expect(
      electronBinary.decideDisableChromiumSandbox({
        ...linuxDefaults,
        apparmorRestrictsUserns: true,
        sandboxHelperStat: { uid: 0, mode: 0o104755 },
      }),
    ).toBe(false);
  });
});

describe("decideOzonePlatform", () => {
  const bare = {
    platform: "linux" as const,
    ozonePlatformOverride: undefined,
    electronOzoneHint: undefined,
    display: undefined,
    waylandDisplay: undefined,
  };

  it("never forces a platform off Linux", () => {
    expect(
      electronBinary.decideOzonePlatform({ ...bare, platform: "darwin" }),
    ).toBeNull();
  });

  it("forces x11 when an X display exists, even beside a Wayland socket", () => {
    expect(
      electronBinary.decideOzonePlatform({
        ...bare,
        display: ":0",
        waylandDisplay: "wayland-0",
      }),
    ).toBe("x11");
  });

  it("leaves a Wayland-only session to Electron's native selection", () => {
    expect(
      electronBinary.decideOzonePlatform({
        ...bare,
        waylandDisplay: "wayland-0",
      }),
    ).toBeNull();
  });

  it("falls back to headless when no display exists at all", () => {
    expect(electronBinary.decideOzonePlatform(bare)).toBe("headless");
  });

  it("respects the dev runner override above everything", () => {
    expect(
      electronBinary.decideOzonePlatform({
        ...bare,
        ozonePlatformOverride: "wayland",
        display: ":0",
      }),
    ).toBe("wayland");
  });

  it("rejects an override Chromium would not accept", () => {
    expect(() =>
      electronBinary.decideOzonePlatform({
        ...bare,
        ozonePlatformOverride: "wyland",
        display: ":0",
      }),
    ).toThrow(/TRAYCER_DESKTOP_OZONE_PLATFORM must be one of/);
  });

  it("defers to a user-set ELECTRON_OZONE_PLATFORM_HINT", () => {
    expect(
      electronBinary.decideOzonePlatform({
        ...bare,
        electronOzoneHint: "auto",
        display: ":0",
      }),
    ).toBeNull();
  });
});
