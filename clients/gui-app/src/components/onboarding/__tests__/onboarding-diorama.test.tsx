import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { LazyMotion, domAnimation } from "motion/react";
import { OnboardingDiorama } from "@/components/onboarding/onboarding-diorama";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import type { OnboardingAgentGuideState } from "@/components/onboarding/onboarding-agent-guide-pane";
import type { OnboardingHostPicker } from "@/components/onboarding/onboarding-host-picker-model";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";

// Neither scene below draws the guide's title bar, so the picker only has to
// exist for the prop chain that carries it to the agent-guide scene.
const hostPicker: OnboardingHostPicker = {
  scope: hostScopeFixture({}),
  onSelectHost: vi.fn(),
  hasExplicitPick: false,
  streamOnPickedHost: true,
};

const agentGuide: OnboardingAgentGuideState = {
  value: "",
  generatedDefaultContent: "",
  loading: false,
  saving: false,
  error: false,
  onValueChange: vi.fn(),
  onRevertToDefault: vi.fn(),
};

describe("OnboardingDiorama", () => {
  it("renders the provider picker in the shared provider order", () => {
    render(
      <LazyMotion features={domAnimation}>
        <OnboardingDiorama
          actId="providers"
          agentGuide={agentGuide}
          hostPicker={hostPicker}
        />
      </LazyMotion>,
    );

    const list = screen.getByRole("list", {
      name: "Diorama harness options",
    });
    const expectedNames = [
      "Codex",
      "Claude Code",
      "OpenCode",
      "Traycer Inference",
      "OpenRouter",
      "Hugging Face",
      "Droid",
      "Cursor",
      "Copilot",
      "Grok",
      "Kiro",
      "Kilo Code",
      "Kimi",
      "Qwen Code",
      "Antigravity",
      "Amp",
      "Devin",
      "Pi",
      "Hermes Agent",
      "Oh My Pi",
      "Reasonix",
    ];
    const textOrEmpty = (text: string | null): string => text ?? "";
    // Longest match, not first match: display names overlap ("Pi" is a
    // substring of "Oh My Pi"), so a first-match probe would label the Oh My Pi
    // row "Pi" and silently pass a wrong order.
    const longestMatch = (text: string): string =>
      expectedNames
        .filter((name) => text.includes(name))
        .reduce(
          (longest, name) => (name.length > longest.length ? name : longest),
          "",
        );

    expect(
      within(list)
        .getAllByRole("listitem")
        .map((row) => {
          const text = textOrEmpty(row.textContent);
          return longestMatch(text);
        }),
    ).toEqual(expectedNames);
  });

  it("renders no mini-app for the act whose stage is the real wizard", () => {
    const { container } = render(
      <LazyMotion features={domAnimation}>
        <OnboardingDiorama
          actId="session-import"
          agentGuide={agentGuide}
          hostPicker={hostPicker}
        />
      </LazyMotion>,
    );

    expect(container.innerHTML).toBe("");
  });

  it("advertises the palette shortcuts through the real formatter and drops the unbound Files hint", () => {
    const { container } = render(
      <LazyMotion features={domAnimation}>
        <OnboardingDiorama
          actId="command-theme"
          agentGuide={agentGuide}
          hostPicker={hostPicker}
        />
      </LazyMotion>,
    );

    // `command-theme` mounts TWO <CommandPalette> copies at once - the
    // stacked (narrow-viewport) one and the one inside `CommandThemeScene`
    // (wide-viewport); jsdom applies no responsive CSS, so both are present
    // in the DOM and every assertion below expects a pair.
    const paletteCopies = 2;

    // The header kbd and the "New tab" row both read through the real
    // formatter now, not a hardcoded "Cmd K" / "Cmd T" string that never
    // reflected Windows/Linux keyboards.
    expect(screen.getAllByText(formatChordForDisplay("mod+k"))).toHaveLength(
      paletteCopies,
    );
    const newTabRows = screen
      .getAllByText("New tab")
      .map((label) => label.closest("li"));
    expect(newTabRows).toHaveLength(paletteCopies);
    for (const row of newTabRows) {
      expect(row).not.toBeNull();
      expect(
        within(row as HTMLElement).getByText(formatChordForDisplay("mod+t")),
      ).toBeDefined();
    }

    // Renamed from "New terminal agent" (Cmd T no longer means "new terminal").
    expect(screen.queryByText("New terminal agent")).toBeNull();
    expect(container.textContent).not.toMatch(/Cmd\+?[KTNP]\b/);

    // "Files" has no bound shortcut anymore, so its rows render no hint span -
    // each row's whole text content is just the label.
    const filesRows = screen
      .getAllByText("Files")
      .map((label) => label.closest("li"));
    expect(filesRows).toHaveLength(paletteCopies);
    for (const row of filesRows) {
      expect(row?.textContent).toBe("Files");
    }

    // The decorative palette icon changed from the Command glyph to a Search
    // glyph (the old icon doubled as an unintentional Cmd-key hint).
    expect(container.querySelectorAll("svg.lucide-search")).toHaveLength(
      paletteCopies,
    );
    expect(container.querySelectorAll("svg.lucide-command")).toHaveLength(0);
  });
});
