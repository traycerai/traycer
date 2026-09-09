import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SURFACES_CSS = readFileSync(
  path.resolve(ROOT, "styles/theme-surfaces.css"),
  "utf8",
);
const RESOURCE_POPOVER = readFileSync(
  path.resolve(ROOT, "components/resources/resource-monitor-popover.tsx"),
  "utf8",
);
const NOTIFICATIONS_POPOVER = readFileSync(
  path.resolve(ROOT, "components/notifications/notifications-popover.tsx"),
  "utf8",
);
const NOTIFICATIONS_BELL = readFileSync(
  path.resolve(ROOT, "components/notifications/notifications-bell.tsx"),
  "utf8",
);
const DIALOG = readFileSync(
  path.resolve(ROOT, "components/ui/dialog.tsx"),
  "utf8",
);

describe("glass inset surfaces", () => {
  it("keeps sticky and expanded inset surfaces translucent in resource and notification popovers", () => {
    for (const source of [RESOURCE_POPOVER, NOTIFICATIONS_POPOVER]) {
      expect(source).not.toContain("bg-popover");
      expect(source).toContain("glass-inset");
    }
    expect(RESOURCE_POPOVER).toContain("glass-with-insets");
    expect(NOTIFICATIONS_BELL).toContain("glass-with-insets");
  });

  it("keeps tint on the outer pseudo-surface and solid defaults on inset layers", () => {
    for (const slot of [
      'data-slot="dialog-content"',
      'data-slot="popover-content"',
      'data-slot="dropdown-menu-content"',
      'data-slot="dropdown-menu-sub-content"',
      'data-slot="context-menu-content"',
      'data-slot="context-menu-sub-content"',
      'data-slot="select-content"',
      'data-slot="hover-card-content"',
      'data-slot="office-legend-popover"',
    ]) {
      expect(SURFACES_CSS).toContain(slot);
    }
    expect(DIALOG).toContain('"glass-with-insets fixed');

    const outerRule = /\.glass-with-insets::before\s*\{([^}]*)\}/s.exec(
      SURFACES_CSS,
    )?.[1];
    expect(outerRule).toBeDefined();
    expect(SURFACES_CSS).toMatch(
      /\.glass-with-insets::before[\s\S]*?background-color:\s*color-mix\([\s\S]*?var\(--popover\)[\s\S]*?var\(--glass-opacity/,
    );

    const insetRule = /\.glass-inset\s*\{([^}]*)\}/s.exec(SURFACES_CSS)?.[1];
    expect(insetRule).toBeDefined();
    expect(insetRule).toMatch(/background-color:\s*var\(--popover\)/);
    expect(insetRule).toMatch(/backdrop-filter:\s*none/);

    const enabledInsetRule =
      /:root\[data-glass-enabled\]\s+\.glass-inset\s*\{([^}]*)\}/s.exec(
        SURFACES_CSS,
      )?.[1];
    expect(enabledInsetRule).toBeDefined();
    expect(enabledInsetRule).toMatch(/background-color:\s*transparent/);
    expect(enabledInsetRule).toMatch(/backdrop-filter:\s*blur\(16px\)/);

    const rootRule = /\.glass-with-insets\s*\{([^}]*)\}/s.exec(
      SURFACES_CSS,
    )?.[1];
    expect(rootRule).toBeDefined();
    expect(rootRule).toMatch(/background-color:\s*transparent/);
    expect(rootRule).toMatch(/backdrop-filter:\s*none/);
  });
});
