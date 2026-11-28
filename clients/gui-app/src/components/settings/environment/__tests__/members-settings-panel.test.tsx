import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MembersSettingsPanel } from "@/components/settings/environment/members-settings-panel";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

afterEach(() => {
  cleanup();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

describe("<MembersSettingsPanel />", () => {
  it.each([
    ["Personal", PERSONAL_PICK],
    [
      "a Local row",
      { kind: "local", hostId: "host-a", hostName: "Old laptop" } as const,
    ],
  ])("says only a team has members under %s", (_label, pick) => {
    useSettingsEnvironmentPickStore.setState({ pick });

    render(<MembersSettingsPanel />);

    const card = screen.getByTestId("members-team-only");
    expect(within(card).getByText("Only a team has members")).toBeTruthy();
  });
});
