import { describe, expect, it } from "vitest";
import {
  SETTINGS_SECTIONS,
  settingsSectionPreviewFeature,
  type SettingsSectionId,
} from "@/lib/settings-sections";

// Every Settings page names the preview feature it needs, or none. The
// gated pages are listed with their feature; every other page is listed here
// with the reason it works without one, so a new page fails this test until
// someone places it.
const GATED: Readonly<Record<string, "environments" | "sandboxes">> = {
  secrets: "environments",
  members: "environments",
  "machine-setup": "environments",
  "agent-definitions": "environments",
  credits: "environments",
  sandboxes: "sandboxes",
};

const UNGATED: ReadonlyArray<SettingsSectionId> = [
  // Application settings of this app, read from the window itself.
  "getting-started",
  "general",
  "appearance",
  "browser",
  "opening-behavior",
  "app-notifications",
  "alerts",
  "keybindings",
  "layout",
  "app-diagnostics",
  // Account pages that read the signed-in account, not an environment.
  "devices",
  "link-phone",
  "usage",
  "notifications",
  "delete-account",
  // Agent settings of the host the person is on, which exist without
  // environments.
  "providers",
  "mcp-servers",
  "skills",
  "permissions",
  "agents",
  "fallback",
  "shell",
  "browser-agent-access",
  // The host's own pages.
  "host",
  "worktrees",
  "diagnostics",
  // Development proofs, withheld from production by their own flag.
  "dev-artifact-proof",
  "dev-canvas-proof",
];

describe("the preview feature each Settings page needs", () => {
  it("is exactly the gated map, and nothing else is gated", () => {
    const actual: Record<string, string> = {};
    for (const section of SETTINGS_SECTIONS) {
      const feature = settingsSectionPreviewFeature(section.id);
      if (feature !== null) actual[section.id] = feature;
    }

    expect(actual).toEqual(GATED);
  });

  it("places every page, gated or not, once and only once", () => {
    const placed = [...Object.keys(GATED), ...UNGATED].sort();

    expect(new Set(placed).size).toBe(placed.length);
    expect(placed).toEqual(
      SETTINGS_SECTIONS.map((section) => section.id).sort(),
    );
  });
});
