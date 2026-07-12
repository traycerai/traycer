import { describe, expect, it } from "vitest";
import { resolveDesktopRuntimeIdentity } from "../dev-desktop-runtime";
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
      }),
    ).toEqual({
      appName: "Traycer Dev — spry-panda",
      userDataDirName: "Traycer Dev-traycer-spry-panda-a2acaa5e",
      slot: "traycer-spry-panda-a2acaa5e",
    });
  });

  it("removes the generated hash from a worktree name without the traycer prefix", () => {
    expect(
      resolveDesktopRuntimeIdentity("Traycer Dev", "dev", {
        [DEV_DESKTOP_SLOT_ENV]: "fix-macos-ctrl-chord-passthrough-e1d873c7",
      }),
    ).toEqual({
      appName: "Traycer Dev — fix-macos-ctrl-chord-passthrough",
      userDataDirName: "Traycer Dev-fix-macos-ctrl-chord-passthrough-e1d873c7",
      slot: "fix-macos-ctrl-chord-passthrough-e1d873c7",
    });
  });

  it("keeps a slot with no worktree segment intact", () => {
    expect(
      resolveDesktopRuntimeIdentity("Traycer Dev", "dev", {
        [DEV_DESKTOP_SLOT_ENV]: "traycer-85cb2355",
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
