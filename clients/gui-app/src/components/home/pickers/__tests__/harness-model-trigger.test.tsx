import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessModelTrigger } from "@/components/home/pickers/harness-model-trigger";
import type { HarnessModelSelection } from "@/components/home/data/landing-options";

const SELECTION: HarnessModelSelection = {
  harnessId: "codex",
  modelSlug: "gpt-5.5",
  profileId: "work-profile",
};

describe("<HarnessModelTrigger />", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps the existing accessible summary when no profile data is provided", () => {
    render(
      <HarnessModelTrigger
        selection={SELECTION}
        label="GPT-5.5"
        reasoningLabel="High"
        serviceTierLabel={null}
        serviceTierActive={false}
        profileLabel={null}
        profileAccentDot={null}
        isLoading={false}
        disabled={false}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "GPT-5.5, Thinking High",
      }),
    ).toBeDefined();
  });

  it("keeps the profile accessible without repeating its name in the collapsed trigger", () => {
    render(
      <HarnessModelTrigger
        selection={SELECTION}
        label="GPT-5.5"
        reasoningLabel="High"
        serviceTierLabel={null}
        serviceTierActive={false}
        profileLabel="Work"
        profileAccentDot={{
          profileId: "work-profile",
          accentColor: null,
          label: "work",
        }}
        isLoading={false}
        disabled={false}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "GPT-5.5, Thinking High, Work",
    });
    expect(trigger).toBeDefined();
    expect(trigger.textContent).not.toContain("Work");
    expect(trigger.textContent).toContain("W");
    const profileBadge = Array.from(trigger.querySelectorAll("span")).find(
      (element) =>
        element.textContent === "W" && element.className.includes("absolute"),
    );
    expect(profileBadge?.className).toContain("size-3");
    expect(profileBadge?.className).not.toContain("size-3.5");
  });

  it("renders nothing extra when the provider has under 2 profiles - byte-identical to today", () => {
    render(
      <HarnessModelTrigger
        selection={SELECTION}
        label="GPT-5.5"
        reasoningLabel="High"
        serviceTierLabel={null}
        serviceTierActive={false}
        profileLabel={null}
        profileAccentDot={null}
        isLoading={false}
        disabled={false}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "GPT-5.5, Thinking High",
    });
    expect(trigger.textContent).not.toContain("Work");
  });
});
