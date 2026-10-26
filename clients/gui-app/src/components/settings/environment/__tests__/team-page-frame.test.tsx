import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  mountTeamPage,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

// These cases are about the environments-on behaviour.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on" as const,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireTeamHostClient(),
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

function team(id: string, label: string): EnvironmentDescriptorV11 {
  return {
    environmentId: `env-${id}`,
    ownerKind: "organization",
    ownerId: `team-${id}`,
    roomId: `room-${id}`,
    label,
    effectiveRole: "editor",
    kind: "team",
    hostCount: 1,
    providerHandle: `handle-${id}`,
  };
}

function Draft(): ReactNode {
  const [text, setText] = useState("");
  return (
    <input
      aria-label="Draft"
      value={text}
      onChange={(event) => setText(event.target.value)}
    />
  );
}

function pickTeam(environmentId: string): void {
  act(() => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId },
    });
  });
}

describe("PersonalPageFrame on a team pick", () => {
  const handlers = {
    "environment.list": () => ({
      environments: [team("a", "Acme"), team("b", "Globex")],
    }),
    "environment.host.list": () => ({ hosts: [] }),
  } as const;

  it("mounts the page only once the team resolves, and reads no Personal notices or review", async () => {
    pickTeam("env-a");
    const harness = mountTeamPage({ kind: "host" }, handlers);
    render(
      <PersonalPageFrame section="mcp-servers">
        <Draft />
      </PersonalPageFrame>,
      { wrapper: harness.Wrapper },
    );

    expect(screen.queryByLabelText("Draft")).toBeNull();
    expect(await screen.findByLabelText("Draft")).toBeTruthy();
    expect(harness.paramsOf("environment.notices")).toHaveLength(0);
    expect(harness.paramsOf("environment.review")).toHaveLength(0);
  });

  it("remounts the page, dropping the old team's draft, when another team is picked", async () => {
    pickTeam("env-a");
    const harness = mountTeamPage({ kind: "host" }, handlers);
    render(
      <PersonalPageFrame section="mcp-servers">
        <Draft />
      </PersonalPageFrame>,
      { wrapper: harness.Wrapper },
    );

    await userEvent.type(await screen.findByLabelText("Draft"), "unsent");
    expect(screen.getByLabelText("Draft")).toHaveProperty("value", "unsent");

    pickTeam("env-b");
    await waitFor(() => {
      expect(screen.getByLabelText("Draft")).toHaveProperty("value", "");
    });
  });
});
