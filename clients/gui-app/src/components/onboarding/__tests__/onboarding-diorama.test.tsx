import "../../../../__tests__/test-browser-apis";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { LazyMotion, domAnimation } from "motion/react";
import { OnboardingDiorama } from "@/components/onboarding/onboarding-diorama";
import type { OnboardingAgentGuideState } from "@/components/onboarding/onboarding-diorama";

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
        <OnboardingDiorama stage={3} agentGuide={agentGuide} />
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
      "Droid",
      "Cursor",
      "Copilot",
      "Grok",
      "Kiro",
      "Kilo Code",
      "Kimi",
      "Qwen Code",
      "Amp",
    ];
    const textOrEmpty = (text: string | null): string => text ?? "";

    expect(
      within(list)
        .getAllByRole("listitem")
        .map((row) => {
          const text = textOrEmpty(row.textContent);
          return expectedNames.find((name) => text.includes(name)) ?? "";
        }),
    ).toEqual(expectedNames);
  });
});
