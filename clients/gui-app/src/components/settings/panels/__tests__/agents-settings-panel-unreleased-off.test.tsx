/**
 * The build without environments (`unreleased-features.ts`) shows the Agents
 * page as the release before them did: "Agent selection", the guide alone,
 * with no tab strip and no caption.
 */
vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));
vi.mock("@/components/settings/panels/agent-selection-guide-section", () => ({
  AgentSelectionGuideSection: () => <div data-testid="guide-body" />,
}));
vi.mock("@/components/settings/panels/agent-definitions-tab", () => ({
  AgentDefinitionsTab: () => <div data-testid="definitions-body" />,
}));

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsSettingsPanel } from "@/components/settings/panels/agents-settings-panel";

afterEach(() => {
  cleanup();
});

describe("<AgentsSettingsPanel /> without environments", () => {
  it("is the guide alone under the Agent selection header, with no tabs or caption", () => {
    render(<AgentsSettingsPanel />);

    expect(
      screen.getByRole("heading", { name: "Agent selection" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "How Traycer picks a coding agent, model, and reasoning effort when it spawns child agents. This does not manage the agents inside a Task.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("guide-body")).toBeTruthy();
    expect(screen.queryByTestId("agents-tab-guide")).toBeNull();
    expect(screen.queryByTestId("agents-tab-definitions")).toBeNull();
    expect(screen.queryByTestId("agents-guide-caption")).toBeNull();
    expect(screen.queryByTestId("definitions-body")).toBeNull();
  });
});
