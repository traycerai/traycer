/**
 * Locks down the settings tab kind helpers around the host section.
 * The Settings sidebar's primary entry routes through these helpers, so
 * the host section needs to resolve consistently from path → section
 * id → route options. The legacy `/settings/service` path is preserved
 * as a section-level alias to the Host section so a remembered tab
 * path from before the rename still lands on the current native-
 * packaging surface (the route itself redirects). The legacy
 * `/settings/agents` path is preserved as a section-level alias to
 * Providers now that the agent selection guide lives there.
 */
import { describe, expect, it } from "vitest";
import {
  settingsDefaultPath,
  settingsSectionFromPath,
  settingsSectionPath,
  settingsTabDescriptor,
} from "@/stores/tabs/kinds/settings";
import { settingsTabIntent } from "@/lib/tab-navigation/intents";

describe("settings tab kind - host section", () => {
  it("settingsSectionFromPath maps /settings/host to the host section", () => {
    expect(settingsSectionFromPath("/settings/host")).toBe("host");
  });

  it("settingsSectionFromPath aliases the legacy /settings/service path to the Host section", () => {
    expect(settingsSectionFromPath("/settings/service")).toBe("host");
  });

  it("settingsSectionFromPath aliases the legacy /settings/agents path to Providers", () => {
    expect(settingsSectionFromPath("/settings/agents")).toBe("providers");
  });

  it("settingsSectionPath builds /settings/host for the host section", () => {
    expect(settingsSectionPath("host")).toBe("/settings/host");
  });

  it("settingsTabDescriptor.routeOptions for the host intent navigates to /settings/host", () => {
    const intent = settingsTabIntent("host");
    const options = settingsTabDescriptor.routeOptions(intent);
    expect(options).toEqual({ to: "/settings/host" });
  });

  it("settingsTabDescriptor.routeOptions for the providers intent navigates to /settings/providers", () => {
    const intent = settingsTabIntent("providers");
    const options = settingsTabDescriptor.routeOptions(intent);
    expect(options).toEqual({ to: "/settings/providers" });
  });

  it("settingsTabDescriptor.resolveIntent returns the Host intent for a remembered legacy /settings/service path", () => {
    const intent = settingsTabDescriptor.resolveIntent({
      kind: "settings",
      id: "settings",
      name: "Settings",
      lastPath: "/settings/service",
      route: "/settings/service",
      icon: null,
      canDuplicate: false,
      canOpenInNewWindow: false,
    });
    expect(intent).toEqual(settingsTabIntent("host"));
  });

  it("settingsTabDescriptor.resolveIntent returns the Providers intent for a remembered legacy /settings/agents path", () => {
    const intent = settingsTabDescriptor.resolveIntent({
      kind: "settings",
      id: "settings",
      name: "Settings",
      lastPath: "/settings/agents",
      route: "/settings/agents",
      icon: null,
      canDuplicate: false,
      canOpenInNewWindow: false,
    });
    expect(intent).toEqual(settingsTabIntent("providers"));
  });

  it("settings default path is unchanged", () => {
    expect(settingsDefaultPath()).toBe("/settings/general");
  });
});
