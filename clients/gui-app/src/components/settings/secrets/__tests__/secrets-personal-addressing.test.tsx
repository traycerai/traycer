// The computers holding a copy are covered by `secret-remove-preview-computers`.
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningPersonal: () => ({
      hosts: [],
      state: "ready",
      collisions: [],
      retry: () => undefined,
    }),
  }),
);
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

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentSecretV12,
  SecretVersion,
} from "@traycer/protocol/host/environment-schemas";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import {
  mountTeamPage,
  mountTeamPageNegotiating,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { SECRETS_EMPTY_TEXT } from "@/lib/sandboxes/secrets-page-copy";

// A Personal pick on a computer whose own settings have not moved: the host
// keeps no environment of its own to answer for, so a secrets call that does
// not name Personal's environment is refused. Every call goes through the real
// HostClient (and its routing table) over a recording messenger.

const PERSONAL_ENV = "env-personal";
const NOT_SET_UP = "Your settings are not set up on this host yet.";

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

function secret(): EnvironmentSecretV12 {
  return {
    secretId: "sec-1",
    name: "STRIPE_KEY",
    kind: "api_key",
    protocol: "https",
    destinations: ["api.stripe.com"],
    mode: "brokered",
    state: "live",
    currentVersionId: "ver-1",
    revoked: false,
    updatedAt: 1,
    variables: [],
    providerVariables: [],
  };
}

const versions: SecretVersion[] = [
  {
    versionId: "ver-1",
    ordinal: 1,
    createdAt: Date.UTC(2026, 9, 24, 9, 30),
    supersededAt: null,
    destroyedAt: null,
    current: true,
    rotationState: null,
  },
];

/** Whether a request names Personal's own environment. */
function namesPersonal(request: object): boolean {
  return "environmentId" in request && request.environmentId === PERSONAL_ENV;
}

/** A host that answers a secrets call only for the environment it is named. */
function unsetHostHandlers(): MockHandlerMap<HostRpcRegistry> {
  return {
    "environment.list": () => ({
      environments: [
        {
          environmentId: PERSONAL_ENV,
          ownerKind: "user" as const,
          ownerId: "user-me",
          roomId: "room-personal",
          label: "Personal",
          effectiveRole: "owner" as const,
          kind: "personal" as const,
          hostCount: 1,
          providerHandle: null,
        },
      ],
    }),
    "environment.secrets.list": (request) => {
      if (!namesPersonal(request)) throw new Error(NOT_SET_UP);
      return { secrets: [secret()], removed: [] };
    },
    "environment.secrets.versions": (request) => {
      if (!namesPersonal(request)) throw new Error(NOT_SET_UP);
      return { versions, removal: null };
    },
    "environment.secrets.rotation": (request) => {
      if (!namesPersonal(request)) throw new Error(NOT_SET_UP);
      return { rotation: null, lastVerify: null };
    },
  };
}

function renderSecrets(harness: TeamPageHarness): void {
  const client = requireTeamHostClient();
  render(
    <SecretsPage
      client={client}
      hostId={client.getActiveHostId()}
      emptyText={SECRETS_EMPTY_TEXT}
      hostName={(hostId) => hostId}
    />,
    { wrapper: harness.Wrapper },
  );
}

function sentTo(harness: TeamPageHarness, method: string): unknown[] {
  return harness.paramsOf(method);
}

describe("Personal's secrets on a computer whose settings have not moved", () => {
  it("lists them because the call names Personal's own environment", async () => {
    const harness = mountTeamPage({ kind: "host" }, unsetHostHandlers());
    renderSecrets(harness);

    expect(await screen.findByTestId("secret-row")).toBeTruthy();
    expect(screen.queryByTestId("secrets-page-error")).toBeNull();
    expect(sentTo(harness, "environment.secrets.list")).toEqual([
      { environmentId: PERSONAL_ENV },
    ]);
    expect(sentTo(harness, "environment.secrets.versions")).toEqual([
      { secretId: "sec-1", environmentId: PERSONAL_ENV },
    ]);
  });

  it("sends no secrets call at all before Personal's id is known", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        ...unsetHostHandlers(),
        "environment.list": () => new Promise<never>(() => undefined),
      },
    );
    renderSecrets(harness);

    await vi.waitFor(() => {
      expect(sentTo(harness, "environment.list")).toHaveLength(1);
    });
    expect(sentTo(harness, "environment.secrets.list")).toEqual([]);
    expect(screen.queryByTestId("secrets-empty")).toBeNull();
    expect(screen.queryByTestId("secrets-page-error")).toBeNull();
  });

  it("reads a Local pick through the host's own environment, and says so in its own words", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-local", hostName: "dev-box" },
    });
    const harness = mountTeamPage({ kind: "host" }, unsetHostHandlers());
    renderSecrets(harness);

    const error = await screen.findByTestId("secrets-page-error");
    // K1-a: the page's own line, never the host's refusal body. This pick is
    // the person's own settings on this computer, so it names no team.
    expect(error.textContent).toContain("Couldn't read Personal's secrets.");
    expect(document.body.textContent).not.toContain(NOT_SET_UP);
    expect(document.body.textContent).not.toContain("this team");
    expect(sentTo(harness, "environment.secrets.list")).toEqual([
      { environmentId: null },
    ]);
    expect(screen.queryByTestId("secret-row")).toBeNull();
  });

  it("says the host needs an update when it cannot take a call that names Personal", async () => {
    const harness = mountTeamPageNegotiating(
      { kind: "host" },
      unsetHostHandlers(),
      { "environment.secrets.list": { major: 1, minor: 0 } },
    );
    renderSecrets(harness);

    const error = await screen.findByTestId("secrets-page-error");
    expect(error.textContent).toContain("These secrets need an updated host.");
    expect(error.textContent).not.toContain(
      "Couldn't read Personal's secrets.",
    );
    expect(sentTo(harness, "environment.secrets.list")).toEqual([]);
  });
});
