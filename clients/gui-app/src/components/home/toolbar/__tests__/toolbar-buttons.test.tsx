import { cleanup, render, screen, within } from "@testing-library/react";
import { ShieldCheck } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { ComposerAttachImageTrigger } from "@/components/home/toolbar/composer-attach-image-button";
import { HarnessModelTrigger } from "@/components/home/pickers/harness-model-trigger";
import { PermissionsTrigger } from "@/components/home/pickers/permissions-picker";
import type { HarnessModelSelection } from "@/components/home/data/landing-options";
import type { ModelStyle } from "@/lib/layout/layout-values";

// jsdom applies no stylesheet, so a chip's look is observed where the app
// states it: the class list the real leaf renders. Every case below mounts the
// production component (attach, access, model, provider label), never the
// primitive in isolation, so a call site that opts out of the chip fails here.

const SELECTION: HarnessModelSelection = {
  harnessId: "codex",
  modelSlug: "gpt-5.5",
  profileId: null,
};

function classesOf(element: Element): ReadonlyArray<string> {
  return element.getAttribute("class")?.split(/\s+/).filter(Boolean) ?? [];
}

function renderModelTrigger(reasoningIndicator: ModelStyle): HTMLElement {
  render(
    <HarnessModelTrigger
      selection={SELECTION}
      label="GPT-5.5"
      reasoningLabel="High"
      reasoningStep={{ index: 2, count: 4 }}
      reasoningIndicator={reasoningIndicator}
      serviceTierLabel={null}
      serviceTierActive={false}
      profileLabel={null}
      profileAccentDot={null}
      isLoading={false}
      disabled={false}
      labelDisplay="responsive"
    />,
  );
  return screen.getByRole("button", { name: "GPT-5.5, Thinking High" });
}

function renderAccessTrigger(input: {
  readonly compact: boolean;
  readonly disabled: boolean;
}): HTMLElement {
  render(
    <PermissionsTrigger
      label="Supervised"
      disabled={input.disabled}
      compact={input.compact}
      icon={<ShieldCheck className="size-4 shrink-0" />}
    />,
  );
  return screen.getByRole("button", { name: "Supervised" });
}

describe("composer toolbar chips (L-88)", () => {
  afterEach(() => {
    cleanup();
  });

  it("draws the attach button as a bordered square on the app's own background", () => {
    render(<ComposerAttachImageTrigger />);

    const classes = classesOf(
      screen.getByRole("button", { name: "Attach image" }),
    );
    expect(classes).toContain("border");
    expect(classes).toContain("border-border");
    expect(classes).toContain("bg-background");
    expect(classes).toContain("rounded-md");
    expect(classes).toContain("size-7");
    expect(classes).not.toContain("rounded-full");
  });

  // The square and the pill are one chip at two geometries. Rather than
  // restating each state's value, this reads the states off the square and
  // demands the pill carry the same ones: a state added to one primitive and
  // forgotten on the other is the drift a bordered row shows up immediately.
  it("gives the labelled chip every state the square has", () => {
    render(<ComposerAttachImageTrigger />);
    const squareStates = classesOf(
      screen.getByRole("button", { name: "Attach image" }),
    ).filter((candidate) => candidate.includes(":"));
    cleanup();

    const pillStates = classesOf(
      renderAccessTrigger({ compact: false, disabled: false }),
    );
    for (const state of squareStates) {
      expect(pillStates).toContain(state);
    }

    // ...and the states the redesign owes a bordered chip are all present.
    for (const prefix of [
      "hover:",
      "focus-visible:",
      "active:scale-",
      "data-[state=open]:",
      "disabled:",
      "motion-reduce:",
    ]) {
      expect(
        squareStates.some((state) => state.startsWith(prefix)),
        `no ${prefix} state on the toolbar chip`,
      ).toBe(true);
    }
  });

  // What the parity check above cannot see is a call site whose `className`
  // tailwind-merges a state away. The access pill is that call site.
  it("keeps every state the redesign owes a bordered chip, and hover off a disabled one", () => {
    const trigger = renderAccessTrigger({ compact: false, disabled: true });
    const classes = classesOf(trigger);

    for (const prefix of [
      "hover:",
      "focus-visible:",
      "active:scale-",
      "data-[state=open]:",
      "disabled:",
      "motion-reduce:",
    ]) {
      expect(
        classes.some((state) => state.startsWith(prefix)),
        `no ${prefix} state on the access chip`,
      ).toBe(true);
    }
    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(classes).toContain("disabled:opacity-50");
    expect(classes).toContain("disabled:hover:bg-background");
    expect(classes).toContain("disabled:hover:text-muted-foreground");
  });

  it("collapses the compact access chip to a square with the shield alone", () => {
    const trigger = renderAccessTrigger({ compact: true, disabled: false });

    const classes = classesOf(trigger);
    expect(classes).toContain("size-7");
    expect(classes).toContain("px-0");
    expect(classes).toContain("justify-center");
    const labelGroup = within(trigger).getByText("Supervised").parentElement;
    if (labelGroup === null) throw new Error("access label has no group");
    expect(classesOf(labelGroup)).toContain("hidden");
  });

  it("collapses the full access chip to the same square in a narrow composer", () => {
    const classes = classesOf(
      renderAccessTrigger({ compact: false, disabled: false }),
    );

    expect(classes).toContain("@max-lg:size-7");
    expect(classes).toContain("@max-lg:px-0");
    expect(classes).not.toContain("@max-lg:size-8");
  });

  it("borders the model chip whichever thinking-effort style is chosen", () => {
    for (const style of ["text", "bars", "bars-text"] as const) {
      const classes = classesOf(renderModelTrigger(style));
      expect(classes).toContain("border");
      expect(classes).toContain("bg-background");
      expect(classes).toContain("h-7");
      // The narrow collapse is the chip's own height, not the old 32px circle.
      expect(classes).toContain("@max-lg:size-7");
      expect(classes).not.toContain("@max-lg:size-8");
      cleanup();
    }
  });
});
