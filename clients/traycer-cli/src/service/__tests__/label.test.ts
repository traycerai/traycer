import { describe, expect, it } from "vitest";
import { serviceLabelFor, windowsTaskName } from "../label";
import { DEV_DESKTOP_SLOT_ENV } from "../../store/dev-desktop-slot";

function withDevDesktopSlot(slot: string, fn: () => void): void {
  const previous = process.env[DEV_DESKTOP_SLOT_ENV];
  process.env[DEV_DESKTOP_SLOT_ENV] = slot;
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env[DEV_DESKTOP_SLOT_ENV];
    } else {
      process.env[DEV_DESKTOP_SLOT_ENV] = previous;
    }
  }
}

describe("serviceLabelFor", () => {
  it("uses the production service label for production", () => {
    const label = serviceLabelFor("production");

    expect(label).toEqual({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment: "production",
    });
    expect(windowsTaskName(label)).toBe("\\Traycer\\Host");
  });

  it("gives the dev environment its own service slot", () => {
    const label = serviceLabelFor("dev");

    expect(label).toEqual({
      id: "ai.traycer.host.dev",
      displayName: "Traycer Host (Dev)",
      environment: "dev",
    });
    expect(windowsTaskName(label)).toBe("\\Traycer\\Host-Dev");
  });

  it("uses a slot-specific label for dev-desktop runs", () => {
    withDevDesktopSlot("Worktree Slot", () => {
      const label = serviceLabelFor("dev");

      expect(label).toEqual({
        id: "ai.traycer.host.dev.worktree-slot",
        displayName: "Traycer Host (Dev worktree-slot)",
        environment: "dev",
      });
      expect(windowsTaskName(label)).toBe("\\Traycer\\Host-Dev-Worktree-slot");
    });
  });

  it("gives each non-production environment its own isolated slot", () => {
    const label = serviceLabelFor("staging");

    expect(label).toEqual({
      id: "ai.traycer.host.staging",
      displayName: "Traycer Host (Staging)",
      environment: "staging",
    });
    expect(windowsTaskName(label)).toBe("\\Traycer\\Host-Staging");
  });
});
