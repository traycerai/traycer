import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  ProviderList,
  type ProviderListRow,
} from "@/components/providers/provider-list";

afterEach(cleanup);

describe("ProviderList onboarding order", () => {
  it("preserves the order supplied by the onboarding screen", () => {
    const rows: ReadonlyArray<ProviderListRow> = [
      {
        providerId: "openrouter",
        active: false,
        dimmed: false,
        enabled: true,
        badge: null,
        description: null,
        trailing: null,
        disabledReason: null,
        phoneDescription: null,
        onSelect: null,
      },
      {
        providerId: "claude-code",
        active: false,
        dimmed: false,
        enabled: true,
        badge: null,
        description: null,
        trailing: null,
        disabledReason: null,
        phoneDescription: null,
        onSelect: null,
      },
      {
        providerId: "codex",
        active: false,
        dimmed: false,
        enabled: true,
        badge: null,
        description: null,
        trailing: null,
        disabledReason: null,
        phoneDescription: null,
        onSelect: null,
      },
    ];

    render(
      <ProviderList
        rows={rows}
        variant="onboarding"
        ariaLabel="Providers"
        className=""
        phone={false}
      />,
    );

    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["OpenRouter", "Claude Code", "Codex"]);
  });
});

function phoneRow(overrides: Partial<ProviderListRow>): ProviderListRow {
  return {
    providerId: "codex",
    active: false,
    dimmed: false,
    enabled: false,
    badge: null,
    description: null,
    trailing: null,
    disabledReason: null,
    phoneDescription: "Signed in · 24 skills · 1 plugin",
    onSelect: null,
    ...overrides,
  };
}

/** The card board's own description, which the phone row must not inherit. */
const LONG_SENTENCE =
  "Turn it on now. The first time you pick it, the model picker will walk you through its terminal setup.";

describe("ProviderList phone rows", () => {
  it("renders a name over one short status line, and no card copy", () => {
    const { container } = render(
      <ProviderList
        rows={[phoneRow({ description: LONG_SENTENCE, enabled: true })]}
        variant="onboarding"
        ariaLabel="Providers"
        className=""
        phone
      />,
    );

    const row = container.querySelector(".onboarding-provider-row");
    expect(row?.getAttribute("data-enabled")).toBe("true");
    expect(
      row?.querySelector(".onboarding-provider-row-name")?.textContent,
    ).toBe("Codex");
    expect(
      row?.querySelector(".onboarding-provider-row-meta")?.textContent,
    ).toBe("Signed in · 24 skills · 1 plugin");
    // The card's two-line description and its trailing slot both belong to the
    // board; a 393pt row truncated that sentence mid-word.
    expect(container.textContent).not.toContain(LONG_SENTENCE);

    // One control, and a switch that only draws the state.
    const button = screen.getByRole("button", { name: "Codex" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    const control = row?.querySelector(".onboarding-provider-switch");
    expect(control?.getAttribute("aria-hidden")).toBe("true");
    expect(
      row?.querySelector(".onboarding-provider-switch-thumb"),
    ).toBeTruthy();
  });

  it("gives a row for a CLI the machine does not have no switch and no press", () => {
    const { container } = render(
      <ProviderList
        rows={[
          phoneRow({
            dimmed: true,
            phoneDescription: "Not installed",
            onSelect: () => undefined,
          }),
        ]}
        variant="onboarding"
        ariaLabel="Providers"
        className=""
        phone
      />,
    );

    expect(
      container
        .querySelector(".onboarding-provider-row")
        ?.getAttribute("data-installed"),
    ).toBe("false");
    expect(container.querySelector(".onboarding-provider-switch")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the card board on a pointer viewport", () => {
    const { container } = render(
      <ProviderList
        rows={[phoneRow({ description: "Signed in" })]}
        variant="onboarding"
        ariaLabel="Providers"
        className=""
        phone={false}
      />,
    );

    expect(container.querySelector(".onboarding-provider-card")).toBeTruthy();
    expect(container.querySelector(".onboarding-provider-row")).toBeNull();
  });
});
