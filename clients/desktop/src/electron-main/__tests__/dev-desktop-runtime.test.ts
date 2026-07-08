import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEV_RENDERER_URL,
  devRendererOriginFromEnv,
  devRendererUrlFromEnv,
  resolveDesktopRuntimeIdentity,
  TRAYCER_DESKTOP_DEV_URL_ENV,
} from "../dev-desktop-runtime";
import { DEV_DESKTOP_SLOT_ENV } from "../host/dev-desktop-slot";

describe("dev desktop runtime helpers", () => {
  it("uses the fixed dev renderer URL when no dynamic URL is provided", () => {
    expect(devRendererUrlFromEnv({})).toBe(DEFAULT_DEV_RENDERER_URL);
    expect(devRendererOriginFromEnv({})).toBe(DEFAULT_DEV_RENDERER_URL);
  });

  it("accepts dynamic loopback renderer origins", () => {
    expect(
      devRendererUrlFromEnv({
        [TRAYCER_DESKTOP_DEV_URL_ENV]: "http://localhost:21005",
      }),
    ).toBe("http://localhost:21005");
    expect(
      devRendererUrlFromEnv({
        [TRAYCER_DESKTOP_DEV_URL_ENV]: "http://127.0.0.1:21005/",
      }),
    ).toBe("http://127.0.0.1:21005");
  });

  it("rejects non-loopback or non-origin renderer URLs", () => {
    expect(() =>
      devRendererUrlFromEnv({
        [TRAYCER_DESKTOP_DEV_URL_ENV]: "https://localhost:21005",
      }),
    ).toThrow(/must use http/);
    expect(() =>
      devRendererUrlFromEnv({
        [TRAYCER_DESKTOP_DEV_URL_ENV]: "http://example.com:21005",
      }),
    ).toThrow(/loopback/);
    expect(() =>
      devRendererUrlFromEnv({
        [TRAYCER_DESKTOP_DEV_URL_ENV]: "http://localhost:21005/path",
      }),
    ).toThrow(/origin URL/);
  });

  it("keeps no-slot app identity unchanged", () => {
    expect(resolveDesktopRuntimeIdentity("Traycer Dev", "dev", {})).toEqual({
      appName: "Traycer Dev",
      userDataDirName: null,
      slot: null,
    });
  });

  it("adds a slot suffix only to Electron runtime identity", () => {
    expect(
      resolveDesktopRuntimeIdentity("Traycer Dev", "dev", {
        [DEV_DESKTOP_SLOT_ENV]: "Worktree Slot",
      }),
    ).toEqual({
      appName: "Traycer Dev (worktree-slot)",
      userDataDirName: "Traycer Dev-worktree-slot",
      slot: "worktree-slot",
    });
  });

  it("does not apply a dev slot to non-dev environments", () => {
    expect(
      resolveDesktopRuntimeIdentity("Traycer", "production", {
        [DEV_DESKTOP_SLOT_ENV]: "worktree-slot",
      }),
    ).toEqual({
      appName: "Traycer",
      userDataDirName: null,
      slot: null,
    });
  });
});
