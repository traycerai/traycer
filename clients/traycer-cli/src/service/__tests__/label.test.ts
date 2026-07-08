import { describe, expect, it } from "vitest";
import { serviceLabelFor, windowsTaskName } from "../label";
import { withDevDesktopSlot } from "@traycer-clients/shared/test-fixtures/dev-desktop-slot";

describe("serviceLabelFor", () => {
  it("uses the production service label for production", () => {
    const label = serviceLabelFor("production");

    expect(label).toEqual({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment: "production",
      devSlot: null,
    });
    expect(windowsTaskName(label)).toBe("\\Traycer\\Host");
  });

  it("gives the dev environment its own service slot", () => {
    const label = serviceLabelFor("dev");

    expect(label).toEqual({
      id: "ai.traycer.host.dev",
      displayName: "Traycer Host (Dev)",
      environment: "dev",
      devSlot: null,
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
        devSlot: "worktree-slot",
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
      devSlot: null,
    });
    expect(windowsTaskName(label)).toBe("\\Traycer\\Host-Staging");
  });
});
