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
const DIALOG_SCROLL_SURFACES = [
  "components/settings/panels/notification-hook-editor-dialog.tsx",
  "components/settings/panels/provider-profile-edit-dialog.tsx",
  "components/settings/panels/add-provider-profile-dialog.tsx",
  "components/settings/panels/provider-custom-model-provider-dialog.tsx",
].map((file) => readFileSync(path.resolve(ROOT, file), "utf8"));

describe("glass inset surfaces", () => {
  it("keeps sticky inset surfaces translucent and preserves inset glass wrappers", () => {
    for (const source of [RESOURCE_POPOVER, NOTIFICATIONS_POPOVER]) {
      expect(source).not.toContain("bg-popover");
      expect(source).toContain("glass-inset");
    }
    expect(RESOURCE_POPOVER).toContain("glass-with-insets");
    expect(NOTIFICATIONS_BELL).toContain("glass-with-insets");
    expect(DIALOG).toContain("glass-with-insets");
  });

  it("keeps dialog glass outside each scrolling body", () => {
    for (const source of DIALOG_SCROLL_SURFACES) {
      expect(source).toMatch(/<DialogContent[\s\S]{0,500}overflow-hidden/);
      expect(source).toMatch(/className="[^"]*min-h-0[^"]*overflow-y-auto/);
    }
  });

  it("keeps direct glass surfaces tinted and popper surfaces transparent with a fixed tint layer", () => {
    const directSlots = [
      'data-slot="dialog-content"',
      'data-slot="alert-dialog-content"',
      'data-slot="popover-content"',
      'data-slot="dropdown-menu-content"',
      'data-slot="dropdown-menu-sub-content"',
      'data-slot="context-menu-content"',
      'data-slot="context-menu-sub-content"',
      'data-slot="select-content"',
      'data-slot="hover-card-content"',
      'data-slot="sheet-content"',
      'data-slot="drawer-content"',
      'data-slot="composer-menu"',
      'data-slot="mention-preview-panel"',
      'data-slot="artifact-link-popover"',
      'data-slot="floating-draft-popover"',
      'data-slot="thread-hover-popover"',
      'data-slot="mention-suggestion"',
      'data-slot="quote-selection-popover"',
      'data-slot="office-legend-popover"',
      "data-profile-usage-sidecar",
      "data-minimap-list-card",
      ".tc-editor-bubble-menu",
      ".tc-node-block-toolbar",
      ".glass-with-insets::before",
    ];
    const directRule = /:is\(([\s\S]*?)\)\s*\{([^}]*)\}/.exec(SURFACES_CSS);
    expect(directRule).toBeDefined();
    const directSelector = directRule?.[1] ?? "";
    const directDeclarations = directRule?.[2] ?? "";
    for (const slot of directSlots) expect(directSelector).toContain(slot);
    expect(directDeclarations).toMatch(/background-color:\s*color-mix\(/);
    expect(directDeclarations).toMatch(/backdrop-filter:\s*blur\(16px\)/);

    const popperRule =
      /\[data-radix-popper-content-wrapper\]\s*>\s*:is\(([\s\S]*?)\)\s*\{([^}]*)\}/.exec(
        SURFACES_CSS,
      );
    expect(popperRule).toBeDefined();
    const popperSelector = popperRule?.[1] ?? "";
    const popperDeclarations = popperRule?.[2] ?? "";
    for (const slot of [
      'data-slot="popover-content"',
      'data-slot="dropdown-menu-content"',
      'data-slot="dropdown-menu-sub-content"',
      'data-slot="context-menu-content"',
      'data-slot="context-menu-sub-content"',
      'data-slot="select-content"',
      'data-slot="hover-card-content"',
    ]) {
      expect(popperSelector).toContain(slot);
    }
    expect(popperDeclarations).toMatch(/isolation:\s*isolate/);
    expect(popperDeclarations).toMatch(/background-color:\s*transparent/);
    expect(popperDeclarations).toMatch(/backdrop-filter:\s*none/);
    expect(popperDeclarations).not.toMatch(/transform:/);

    const pseudoRule = /&::before\s*\{([^}]*)\}/s.exec(SURFACES_CSS)?.[1];
    expect(pseudoRule).toBeDefined();
    expect(pseudoRule).toMatch(/content:\s*""/);
    expect(pseudoRule).toMatch(/position:\s*fixed/);
    expect(pseudoRule).toMatch(/inset:\s*0/);
    expect(pseudoRule).toMatch(/z-index:\s*-1/);
    expect(pseudoRule).toMatch(/border-radius:\s*inherit/);
    expect(pseudoRule).toMatch(/pointer-events:\s*none/);
    expect(pseudoRule).toMatch(/background-color:\s*color-mix\(/);
    expect(pseudoRule).toMatch(/var\(--popover\)/);
    expect(pseudoRule).toMatch(/var\(--glass-opacity/);
    expect(pseudoRule).toMatch(/backdrop-filter:\s*blur\(16px\)/);

    expect(SURFACES_CSS).toMatch(
      /\)\s*\[data-state="open"]\s*\{[^}]*animation-fill-mode:\s*backwards/,
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
  });
});
