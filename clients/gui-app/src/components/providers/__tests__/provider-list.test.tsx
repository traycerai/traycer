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
        onSelect: null,
      },
    ];

    render(
      <ProviderList
        rows={rows}
        variant="onboarding"
        ariaLabel="Providers"
        className=""
      />,
    );

    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["OpenRouter", "Claude Code", "Codex"]);
  });
});
