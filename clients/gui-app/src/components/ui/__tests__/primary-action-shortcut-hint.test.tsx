import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PrimaryActionShortcutHint } from "@/components/ui/primary-action-shortcut-hint";
import { contrastRatio } from "../../../../__tests__/contrast";

const PRIMARY_ACTION_PRESETS = [
  ["amoled light", "#171717", "#ffffff"],
  ["amoled dark", "#ededed", "#000000"],
  ["traycer-green light", "#257174", "#ffffff"],
  ["traycer-green dark", "#257174", "#ffffff"],
  ["dracula light", "#6272a4", "#ffffff"],
  ["dracula dark", "#bd93f9", "#282a36"],
  ["catppuccin light", "#8839ef", "#ffffff"],
  ["catppuccin dark", "#cba6f7", "#1e1e2e"],
  ["github light", "#0969da", "#ffffff"],
  ["github dark", "#58a6ff", "#0d1117"],
  ["gruvbox light", "#8f5902", "#fbf1c7"],
  ["gruvbox dark", "#fabd2f", "#282828"],
  ["tokyo-night light", "#256bd4", "#ffffff"],
  ["tokyo-night dark", "#7aa2f7", "#1a1b26"],
  ["nord light", "#52739b", "#ffffff"],
  ["nord dark", "#88c0d0", "#2e3440"],
  ["ayu light", "#ff9940", "#0b0e14"],
  ["ayu dark", "#e6b450", "#0b0e14"],
  ["everforest light", "#8da101", "#232a2e"],
  ["everforest dark", "#a7c080", "#2d353b"],
] as const;

describe("PrimaryActionShortcutHint", () => {
  it("keeps keycaps at the action label contrast across full-palette presets", () => {
    const { container } = render(
      <div className="bg-primary text-primary-foreground">
        Launch
        <PrimaryActionShortcutHint />
      </div>,
    );

    const keycaps = [...container.querySelectorAll('[data-slot="kbd"]')];
    expect(keycaps).toHaveLength(2);
    for (const keycap of keycaps) {
      expect(keycap.className).toContain("border-current");
      expect(keycap.className).toContain("bg-transparent");
      expect(keycap.className).toContain("text-current");
    }

    const failures = PRIMARY_ACTION_PRESETS.flatMap(
      ([preset, background, foreground]) => {
        const ratio = contrastRatio(foreground, background);
        return ratio < 4.5 ? [`${preset}: ${ratio.toFixed(2)}`] : [];
      },
    );
    expect(failures).toEqual([]);
  });
});
