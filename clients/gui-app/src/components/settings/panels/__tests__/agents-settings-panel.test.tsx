import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";
import { searchSettings } from "@/lib/settings-search/settings-search";
import { AgentsSettingsPanel } from "../agents-settings-panel";

vi.mock("../agent-selection-guide-section", () => ({
  AgentSelectionGuideSection: () => null,
}));

vi.mock("@/components/settings/personal/personal-page-frame", () => ({
  PersonalPageHeaderStatus: () => null,
}));

// The guide only reaches agents Traycer creates; a provider's native
// subagents keep their provider's settings (traycerai/traycer#1090).
const NATIVE_SUBAGENTS = "Native subagents keep their provider's settings.";

afterEach(() => {
  cleanup();
});

describe("Agent selection page copy", () => {
  it("says on the page that native subagents are not configured here", () => {
    render(<AgentsSettingsPanel />);

    const description = screen.getByText(/^How Traycer picks a coding agent/);
    expect(description.textContent).toContain(NATIVE_SUBAGENTS);
  });

  it("says the same in the settings search result", () => {
    const page = searchSettings("Agent selection", {
      runnerHost: createFakeRunnerHost({}),
      featureSettings: null,
      mobileApp: false,
      phoneLayout: false,
    }).find(
      (result) =>
        result.entry.kind === "section" && result.entry.section === "agents",
    );

    expect(page?.entry.description).toContain(NATIVE_SUBAGENTS);
  });
});
