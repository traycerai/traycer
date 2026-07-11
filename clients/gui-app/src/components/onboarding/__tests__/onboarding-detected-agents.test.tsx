import "../../../../__tests__/test-browser-apis";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    data: { providers: [] },
    isPending: false,
    isError: false,
    fetchStatus: "idle",
  }),
}));

vi.mock("@/hooks/providers/use-providers-set-enabled-mutation", () => ({
  useProvidersSetEnabled: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
}));

import { OnboardingDetectedAgents } from "@/components/onboarding/onboarding-detected-agents";

describe("OnboardingDetectedAgents", () => {
  it("renders providers in the shared provider order", () => {
    render(<OnboardingDetectedAgents />);

    const expectedNames = [
      "Codex",
      "Claude Code",
      "OpenCode",
      "Traycer Inference",
      "OpenRouter",
      "Droid",
      "Cursor",
      "Copilot",
      "Grok",
      "Kiro",
      "Kilo Code",
      "Kimi",
      "Qwen Code",
      "Amp",
      "Devin",
      "Pi",
    ];
    const textOrEmpty = (text: string | null): string => text ?? "";

    expect(
      screen.getAllByRole("listitem").map((row) => {
        const text = textOrEmpty(row.textContent);
        return expectedNames.find((name) => text.includes(name)) ?? "";
      }),
    ).toEqual(expectedNames);
  });
});
