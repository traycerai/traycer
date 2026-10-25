import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// Both tabs have their own suites; here they are markers, so the page's title
// and tab switching are what is under test.
vi.mock("@/components/settings/panels/agent-selection-guide-section", () => ({
  AgentSelectionGuideSection: () => <div data-testid="guide-body" />,
}));
vi.mock("@/components/settings/panels/agent-definitions-tab", () => ({
  AgentDefinitionsTab: () => <div data-testid="definitions-body" />,
}));
vi.mock("@/components/settings/environment/environment-host-binding", () => ({
  EnvironmentHostBinding: (props: { readonly children: React.ReactNode }) => (
    <div data-testid="host-binding">{props.children}</div>
  ),
}));

import { AgentsSettingsPanel } from "@/components/settings/panels/agents-settings-panel";

afterEach(() => {
  cleanup();
});

describe("<AgentsSettingsPanel />", () => {
  it("is titled Agents and opens on the Selection guide", () => {
    render(<AgentsSettingsPanel />);

    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(
      screen.getByText(
        "How agents are picked, and the agents a harness can start.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("agents-tab-guide").textContent).toBe(
      "Selection guide",
    );
    expect(screen.getByTestId("agents-tab-definitions").textContent).toBe(
      "Definitions",
    );
    expect(screen.getByTestId("guide-body")).toBeTruthy();
    expect(screen.queryByTestId("definitions-body")).toBeNull();
  });

  // The guide reaches only the agents Traycer creates; a coding agent's own
  // native subagents never read it (traycerai/traycer#1090).
  it("says on the Selection guide tab that native subagents keep their provider's settings", async () => {
    render(<AgentsSettingsPanel />);

    expect(screen.getByTestId("agents-guide-caption").textContent).toBe(
      "The guide agents read when they pick a coding agent, model and effort for work they hand off. Native subagents keep their provider's settings.",
    );

    await userEvent.click(screen.getByTestId("agents-tab-definitions"));
    expect(screen.queryByTestId("agents-guide-caption")).toBeNull();
  });

  it("switches to Definitions, read through the Environment's host binding, and back", async () => {
    render(<AgentsSettingsPanel />);

    await userEvent.click(screen.getByTestId("agents-tab-definitions"));
    expect(
      screen
        .getByTestId("host-binding")
        .contains(screen.getByTestId("definitions-body")),
    ).toBe(true);
    expect(screen.queryByTestId("guide-body")).toBeNull();

    await userEvent.click(screen.getByTestId("agents-tab-guide"));
    expect(screen.getByTestId("guide-body")).toBeTruthy();
    expect(screen.queryByTestId("definitions-body")).toBeNull();
  });
});
