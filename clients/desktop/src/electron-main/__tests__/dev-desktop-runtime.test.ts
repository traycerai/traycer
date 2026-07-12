import { describe, expect, it } from "vitest";
import {
  DEV_DESKTOP_DISPLAY_NAME_ENV,
  resolveDesktopRuntimeIdentity,
} from "../dev-desktop-runtime";
import { DEV_DESKTOP_SLOT_ENV } from "../host/dev-desktop-slot";

describe("dev desktop runtime helpers", () => {
  it("keeps no-slot app identity unchanged", () => {
    expect(resolveDesktopRuntimeIdentity("Traycer Dev", "dev", {})).toEqual({
      appName: "Traycer Dev",
      userDataDirName: null,
      slot: null,
    });
  });

  it("uses the worktree name in the dev display identity while preserving the full slot for isolation", () => {
    expect(
      resolveDesktopRuntimeIdentity("Traycer Dev", "dev", {
        [DEV_DESKTOP_SLOT_ENV]: "traycer-spry-panda-a2acaa5e",
        [DEV_DESKTOP_DISPLAY_NAME_ENV]: "Traycer Dev — spry-panda",
      }),
    ).toEqual({
      appName: "Traycer Dev — spry-panda",
      userDataDirName: "Traycer Dev-traycer-spry-panda-a2acaa5e",
      slot: "traycer-spry-panda-a2acaa5e",
    });
  });

  it("uses the threaded display name for a worktree without the traycer prefix", () => {
    expect(
      resolveDesktopRuntimeIdentity("Traycer Dev", "dev", {
        [DEV_DESKTOP_SLOT_ENV]: "fix-macos-ctrl-chord-passthrough-e1d873c7",
        [DEV_DESKTOP_DISPLAY_NAME_ENV]:
          "Traycer Dev — fix-macos-ctrl-chord-passthrough",
      }),
    ).toEqual({
      appName: "Traycer Dev — fix-macos-ctrl-chord-passthrough",
      userDataDirName: "Traycer Dev-fix-macos-ctrl-chord-passthrough-e1d873c7",
      slot: "fix-macos-ctrl-chord-passthrough-e1d873c7",
    });
  });

  it("uses the threaded full display name for a slot with no worktree segment", () => {
    expect(
      resolveDesktopRuntimeIdentity("Traycer Dev", "dev", {
        [DEV_DESKTOP_SLOT_ENV]: "traycer-85cb2355",
        [DEV_DESKTOP_DISPLAY_NAME_ENV]: "Traycer Dev — traycer-85cb2355",
      }),
    ).toEqual({
      appName: "Traycer Dev — traycer-85cb2355",
      userDataDirName: "Traycer Dev-traycer-85cb2355",
      slot: "traycer-85cb2355",
    });
  });

  it("keeps an explicitly requested slot intact in the dev display identity", () => {
    expect(
      resolveDesktopRuntimeIdentity("Traycer Dev", "dev", {
        [DEV_DESKTOP_SLOT_ENV]: "Worktree Slot",
        [DEV_DESKTOP_DISPLAY_NAME_ENV]: "Traycer Dev — worktree-slot",
      }),
    ).toEqual({
      appName: "Traycer Dev — worktree-slot",
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
