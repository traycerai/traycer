import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  useHostLongTurnAlertForClient,
  useHostSetLongTurnAlertForClient,
} from "@/hooks/host/use-host-notifications-long-turn-alert";
import { useHostClient } from "@/lib/host";
import { ConfigurationSourceBoundary } from "@/components/settings/environment/configuration-source-boundary";
import { NotificationLongTurnAlertRow } from "@/components/settings/panels/notification-long-turn-alert-row";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLocalTeamAdmissionStore } from "@/stores/host/local-team-admission-store";
import { negotiateMethods } from "../../environment/__tests__/mcp-skills-test-support";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "../../environment/__tests__/team-configuration-test-support";

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

const VERSION_1 = { major: 1, minor: 0 } as const;
const HOUR_MS = 3_600_000;

const PERSONAL: EnvironmentDescriptorV11 = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: "user-me",
  roomId: "room-personal",
  label: "Personal",
  effectiveRole: "owner",
  kind: "personal",
  hostCount: 1,
  providerHandle: null,
};

const TEAM: EnvironmentDescriptorV11 = {
  environmentId: "env-team",
  ownerKind: "organization",
  ownerId: "team-a",
  roomId: "room-team",
  label: "Acme",
  effectiveRole: "viewer",
  kind: "team",
  hostCount: 1,
  providerHandle: "acme",
};

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  useLocalTeamAdmissionStore.setState({ byHost: new Map() });
});

function LongTurnAlert(): ReactNode {
  const client = useHostClient();
  return (
    <NotificationLongTurnAlertRow
      query={useHostLongTurnAlertForClient(client)}
      setAlert={useHostSetLongTurnAlertForClient(client)}
    />
  );
}

it("keeps the computer's long-turn alert editable for a team Viewer", async () => {
  const setRequests: { thresholdMs: number | null }[] = [];
  negotiateMethods({
    "environment.invitations.list": VERSION_1,
    "environment.invitations.accept": VERSION_1,
  });
  const harness = mountTeamPage(poolSource("admin"), {
    "environment.list": () => ({ environments: [PERSONAL, TEAM] }),
    "environment.invitations.list": () => ({ invitations: [] }),
    "host.notifications.getLongTurnAlert": () => ({ thresholdMs: null }),
    "host.notifications.setLongTurnAlert": (request) => {
      setRequests.push(request);
      return { thresholdMs: request.thresholdMs };
    },
  });
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-me", username: "user-me" },
  });
  useLocalTeamAdmissionStore.setState({
    byHost: new Map([
      [mockLocalHostEntry.hostId, { userId: "user-me", state: "admitted" }],
    ]),
  });
  render(
    <ConfigurationSourceBoundary
      target={{ kind: "team", environmentId: "env-team" }}
      section={null}
    >
      <LongTurnAlert />
    </ConfigurationSourceBoundary>,
    { wrapper: harness.Wrapper },
  );

  const toggle = await screen.findByRole("switch", {
    name: "Alert when a turn runs longer than",
  });
  expect(toggle.getAttribute("data-state")).toBe("unchecked");
  fireEvent.click(toggle);

  await waitFor(() => {
    expect(setRequests).toEqual([{ thresholdMs: 4 * HOUR_MS }]);
  });
  expect(
    screen.getByText("You can see Acme's settings but not change them."),
  ).toBeTruthy();
});
