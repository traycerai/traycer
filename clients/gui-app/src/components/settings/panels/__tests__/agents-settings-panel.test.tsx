import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostManifest,
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

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
  resetNegotiatedManifests();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

const OLD_HOST_PICK = {
  kind: "local",
  hostId: "host-old",
  hostName: "Old laptop",
} as const;

describe("<AgentsSettingsPanel />", () => {
  it("is titled Agents and opens on the Selection guide", () => {
    render(<AgentsSettingsPanel />);

    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(
      screen.getByText(
        "How agents are picked, and the agents each coding agent can start.",
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

  it("captions the Selection guide tab with what agents read, only there", async () => {
    render(<AgentsSettingsPanel />);

    expect(screen.getByTestId("agents-guide-caption").textContent).toBe(
      "The guide agents read when they pick a coding agent, model and effort for work they hand off.",
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

  it("is the Selection guide alone on a Local pick of a host whose methods lack environment.status", () => {
    recordNegotiatedHostMethods("host-old", ["host.status"]);
    useSettingsEnvironmentPickStore.setState({ pick: OLD_HOST_PICK });

    render(<AgentsSettingsPanel />);

    expect(screen.getByTestId("guide-body")).toBeTruthy();
    expect(screen.queryByTestId("agents-tab-definitions")).toBeNull();
    expect(
      screen.queryByText("Update this host to use agent definitions."),
    ).toBeNull();
  });

  it("keeps the Definitions tab on a Local pick of a host that advertises environment.status", () => {
    recordNegotiatedHostManifest("host-old", {
      "environment.status": { major: 1, minor: 3 },
    });
    useSettingsEnvironmentPickStore.setState({ pick: OLD_HOST_PICK });

    render(<AgentsSettingsPanel />);

    expect(screen.getByTestId("agents-tab-definitions").textContent).toBe(
      "Definitions",
    );
  });
});
