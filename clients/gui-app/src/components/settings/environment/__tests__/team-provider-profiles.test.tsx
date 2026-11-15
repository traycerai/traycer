import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { TeamProviders } from "@/components/settings/environment/team-providers";
import { TeamMcpServers } from "@/components/settings/environment/team-mcp-servers";
import { TeamProfileApiKeyForm } from "@/components/settings/environment/team-profile-api-key-form";
import { WAITING_FOR_PROFILE_TEXT } from "@/components/providers/profile-sync-copy";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";
import { PROVIDER_STATE_UNREADABLE_COPY } from "@/lib/providers/provider-settings-unreadable-error";
import {
  admitCurrentUserToTeamWindow,
  configurationItem,
  mountTeamPage,
  mountTeamPageThroughBoundary,
  mountPersonalProvidersThroughBoundary,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  TEAM_PROFILE_KEY_CANARY,
  teamProfileRecord,
  teamProfileRecordsBody,
  teamProfileRecordHttpBoundary,
  teamAwaitLoginOutcomeAnswer,
  teamAwaitLoginSignInRequestAnswer,
  teamLoginStartedAnswer,
} from "./team-configuration-test-support";
import {
  negotiateMethods,
  providerState,
  reachableHost,
  WINDOW_HOST_ID,
} from "./mcp-skills-test-support";
import {
  profile,
  cursorProviderListRow,
  cursorKey,
  teamProfile,
  teamProviderProfile,
  profileTriggerName,
  openProfileMenu,
  profileRowSwitch,
  openProfileEditor,
  handlers,
  railButton,
} from "./team-providers-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
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
vi.mock("@/components/settings/secrets/secret-row", () => ({
  SecretRow: () => null,
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => () => Promise.resolve(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() },
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  useSettingsEnvironmentPickStore.setState({ pick: null });
  setSystemTabModalApi(null);
  vi.mocked(toast.error).mockClear();
  vi.restoreAllMocks();
});

function teamProfileRecordReadCount(): number {
  return teamProfileRecordHttpBoundary.calls.filter(
    (call) =>
      call.url.endsWith("/api/v3/environments/env-a/profile-records") &&
      call.method === "GET",
  ).length;
}

function cursorProviderWithTeamRecordKey() {
  return {
    ...cursorProviderListRow(),
    apiKey: {
      supported: true,
      configured: true,
      source: "stored" as const,
      recordEnvironmentId: "env-a",
    },
  };
}

function teamProviderEnvironmentStatus() {
  return {
    principal: { kind: "team" as const, teamName: "Acme" },
    reachability: "connected" as const,
    bindingGeneration: 1,
    desiredRevision: null,
    receivedRevision: null,
    appliedRevision: null,
    receiptAgeMs: 0,
    items: [],
    pendingUploads: [],
    setup: null,
    remoteAccess: "on" as const,
    consent: null,
    planes: { records: "moved", broker: "moved", room: "moved" } as const,
    returnedFromTeam: null,
    stoppedAt: null,
    acceptedUploads: [],
  };
}

function claudeLoginProviderRow() {
  return {
    ...providerState("claude-code", { mcp: false, skills: false }),
    candidates: [
      {
        kind: "bundled" as const,
        path: "/opt/traycer/bin/claude",
        version: "1.0.0",
        available: true,
        versionPending: false,
      },
    ],
    loginCapability: {
      oauthArgs: ["login"],
      token: null,
      codePaste: null,
      terminalLogin: null,
      remoteSafe: null,
      selfOpensBrowser: null,
    },
  };
}

beforeEach(() => {
  resetNegotiatedManifests();
});

describe("TeamProviders profiles", () => {
  it.each([
    {
      label: "binding change",
      answer: { status: 409, body: { code: "binding-changed" } },
      message: "This connection changed. Refresh and try again.",
    },
    {
      label: "malformed key",
      answer: { status: 422, body: { code: "harness_token_shape" } },
      message: "Couldn't save the API key.",
    },
    {
      label: "unauthorized session",
      answer: { status: 401, body: null },
      message: "Please sign in again.",
    },
    {
      label: "role changed before the write",
      answer: { status: 403, body: null },
      message: "You don't have permission to do that.",
    },
    {
      label: "unproven account",
      answer: {
        status: 409,
        body: { code: "profile_record_account_unproven" },
      },
      message: "Couldn't save the API key.",
    },
    {
      label: "removed account",
      answer: { status: 404, body: { code: "profile_record_not_found" } },
      message: "Was removed",
    },
    {
      label: "uncoded server failure",
      answer: { status: 500, body: { code: "server-failure" } },
      message: "Couldn't save the API key.",
    },
  ])(
    "shows the existing API-key refusal for $label through AuthService and the HTTP helper",
    async ({ answer, message }) => {
      teamProfileRecordHttpBoundary.list = {
        status: 200,
        body: teamProfileRecordsBody([
          teamProfileRecord({
            profileId: "team-api-key",
            harnessId: "claude",
            name: "Team API key",
            readerLabel: "live",
            kind: "api_key",
          }),
        ]),
      };
      teamProfileRecordHttpBoundary.replaceKey = answer;
      const harness = mountTeamPageThroughBoundary(
        "admin",
        handlers(() => []),
        "providers",
      );
      const profile = teamProviderProfile({
        profileId: "team-api-key",
        label: "Team API key",
        authStatus: "authenticated",
        personNotice: null,
        apiKeyConfigured: true,
      });
      await waitFor(() => {
        expect(useAuthStore.getState().contextMetadata?.userId).toBe(
          "team-test-user",
        );
      });
      admitCurrentUserToTeamWindow();
      render(
        <TeamProfileApiKeyForm
          providerId="claude-code"
          profile={profile}
          environmentId="env-a"
          reread={() => harness.auth.readProfileRecords("env-a", null)}
        />,
        { wrapper: harness.Wrapper },
      );
      const warningLog = vi.spyOn(console, "warn");
      const errorLog = vi.spyOn(console, "error");
      fireEvent.change(await screen.findByLabelText("API key"), {
        target: { value: TEAM_PROFILE_KEY_CANARY },
      });
      await userEvent.click(
        screen.getByRole("button", { name: "Replace key" }),
      );
      await waitFor(() => {
        const result = screen.queryByRole("status");
        if (result?.textContent !== message)
          throw new Error("expected the fixed API-key refusal");
      });
      expect(teamProfileRecordHttpBoundary.keyCanaryForwarded).toBe(true);

      const requestNames = teamProfileRecordHttpBoundary.calls
        .filter((call) => call.url.includes("/harness-connections"))
        .map((call) => ({
          method: call.method,
          url: new URL(call.url).pathname,
        }));
      expect(requestNames).toEqual([
        {
          method: "GET",
          url: "/api/v3/environments/env-a/secrets/harness-connections",
        },
        {
          method: "POST",
          url: "/api/v3/environments/env-a/secrets/harness-connections/team-api-key/connect",
        },
      ]);
      expect(
        teamProfileRecordHttpBoundary.calls.filter((call) =>
          call.url.endsWith("/api/v3/environments/env-a/profile-records"),
        ),
      ).toHaveLength(1);
      expect(
        teamProfileRecordHttpBoundary.calls.find((call) =>
          call.url.endsWith("/team-api-key/connect"),
        )?.body,
      ).toBeNull();
      const observableOutput = JSON.stringify({
        calls: teamProfileRecordHttpBoundary.calls,
        result: screen.queryByRole("status")?.textContent ?? null,
        logs: [...warningLog.mock.calls, ...errorLog.mock.calls],
      });
      expect(observableOutput.includes(TEAM_PROFILE_KEY_CANARY)).toBe(false);
    },
  );

  it("does not POST a replacement when the pre-read has no exact record id", async () => {
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([
        teamProfileRecord({
          profileId: "team-api-key",
          harnessId: "claude",
          name: "Team API key",
          readerLabel: "live",
          kind: "api_key",
        }),
      ]),
    };
    teamProfileRecordHttpBoundary.connections = {
      status: 200,
      body: {
        connections: [{ profileId: "different-record", bindingVersion: 4 }],
      },
    };
    const harness = mountTeamPageThroughBoundary(
      "admin",
      handlers(() => []),
      "providers",
    );
    await waitFor(() => {
      expect(useAuthStore.getState().contextMetadata?.userId).toBe(
        "team-test-user",
      );
    });
    admitCurrentUserToTeamWindow();
    render(
      <TeamProfileApiKeyForm
        providerId="claude-code"
        profile={teamProviderProfile({
          profileId: "team-api-key",
          label: "Team API key",
          authStatus: "authenticated",
          personNotice: null,
          apiKeyConfigured: true,
        })}
        environmentId="env-a"
        reread={() => harness.auth.readProfileRecords("env-a", null)}
      />,
      { wrapper: harness.Wrapper },
    );

    fireEvent.change(await screen.findByLabelText("API key"), {
      target: { value: TEAM_PROFILE_KEY_CANARY },
    });
    await userEvent.click(screen.getByRole("button", { name: "Replace key" }));

    expect((await screen.findByRole("status")).textContent).toBe(
      "Couldn't save the API key.",
    );
    expect(teamProfileRecordHttpBoundary.keyCanaryForwarded).toBe(false);
    expect(
      teamProfileRecordHttpBoundary.calls
        .filter((call) => call.url.includes("/harness-connections"))
        .map((call) => call.method),
    ).toEqual(["GET"]);
  });

  it("clears a replaced key without exposing it in the UI or app logs", async () => {
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([
        teamProfileRecord({
          profileId: "team-api-key",
          harnessId: "claude",
          name: "Team API key",
          readerLabel: "live",
          kind: "api_key",
        }),
      ]),
    };
    const harness = mountTeamPageThroughBoundary(
      "admin",
      handlers(() => []),
      "providers",
    );
    await waitFor(() => {
      expect(useAuthStore.getState().contextMetadata?.userId).toBe(
        "team-test-user",
      );
    });
    admitCurrentUserToTeamWindow();
    render(
      <TeamProfileApiKeyForm
        providerId="claude-code"
        profile={teamProviderProfile({
          profileId: "team-api-key",
          label: "Team API key",
          authStatus: "authenticated",
          personNotice: null,
          apiKeyConfigured: true,
        })}
        environmentId="env-a"
        reread={() => harness.auth.readProfileRecords("env-a", null)}
      />,
      { wrapper: harness.Wrapper },
    );
    const warningLog = vi.spyOn(console, "warn");
    const errorLog = vi.spyOn(console, "error");

    fireEvent.change(await screen.findByLabelText("API key"), {
      target: { value: TEAM_PROFILE_KEY_CANARY },
    });
    await userEvent.click(screen.getByRole("button", { name: "Replace key" }));

    await waitFor(() => {
      expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
    });
    expect(teamProfileRecordHttpBoundary.keyCanaryForwarded).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
    const observableOutput = JSON.stringify({
      calls: teamProfileRecordHttpBoundary.calls,
      logs: [...warningLog.mock.calls, ...errorLog.mock.calls],
    });
    expect(observableOutput.includes(TEAM_PROFILE_KEY_CANARY)).toBe(false);
  });

  it("lets a team admin use account controls and the record key field through the real boundary", async () => {
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([
        teamProfileRecord({
          profileId: "team-admin-profile",
          harnessId: "claude",
          name: "Team admin profile",
          readerLabel: "live",
          kind: "oauth_code",
        }),
      ]),
    };
    const cursorState = cursorProviderWithTeamRecordKey();
    const harness = mountTeamPageThroughBoundary(
      "admin",
      {
        ...handlers(() => []),
        "environment.host.list": () => ({ hosts: [reachableHost] }),
        "environment.status": () => teamProviderEnvironmentStatus(),
        "providers.list": () => ({ providers: [cursorState], native: null }),
        "providers.beginApiKeyChange": () => ({
          mode: "record",
          changeToken: "test-change-token",
          environmentId: "env-a",
        }),
        "providers.clearApiKey": () => ({ state: cursorState }),
        "providers.settleApiKeyChange": () => ({
          state: cursorState,
          result: "installed",
        }),
      },
      "providers",
    );
    negotiateMethods({
      "environment.status": { major: 1, minor: 2 },
      "providers.beginApiKeyChange": { major: 1, minor: 0 },
      "providers.list": { major: 10, minor: 13 },
    });
    await waitFor(() => {
      expect(useAuthStore.getState().contextMetadata?.userId).toBe(
        "team-test-user",
      );
    });
    admitCurrentUserToTeamWindow();
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByRole("button", { name: "Add a profile" }),
    ).toBeTruthy();
    expect(
      screen.queryByText("You can see Acme's settings but not change them."),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Add a profile" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Add a profile" }),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(railButton("Cursor"));

    const clear = await screen.findByRole("button", { name: "Clear" });
    expect(screen.getByLabelText("API key")).toBeTruthy();
    await userEvent.click(clear);
    await waitFor(() => {
      expect(
        teamProfileRecordHttpBoundary.calls.some(
          (call) =>
            call.url.endsWith(
              "/api/v3/environments/env-a/provider-keys/cursor",
            ) && call.method === "DELETE",
        ),
      ).toBe(true);
    });
    expect(harness.paramsOf("providers.clearApiKey")).toEqual([]);
    expect(harness.paramsOf("providers.beginApiKeyChange")).toEqual([
      { providerId: "cursor" },
    ]);
    expect(harness.paramsOf("providers.settleApiKeyChange")).toEqual([
      {
        providerId: "cursor",
        changeToken: "test-change-token",
        action: "clear",
        recordId: "team-key-profile",
        signInNumber: "1",
        recordRevision: "2",
      },
    ]);
  });

  it("keeps the read-only line and hides account controls for a viewer through the real boundary", async () => {
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([
        teamProfileRecord({
          profileId: "team-viewer-profile",
          harnessId: "claude",
          name: "Team viewer profile",
          readerLabel: "needs-sign-in",
          kind: "oauth_code",
        }),
      ]),
    };
    const cursorState = cursorProviderWithTeamRecordKey();
    const harness = mountTeamPageThroughBoundary(
      "viewer",
      {
        ...handlers(() => []),
        "environment.host.list": () => ({ hosts: [reachableHost] }),
        "environment.status": () => teamProviderEnvironmentStatus(),
        "providers.list": () => ({ providers: [cursorState], native: null }),
        "providers.beginApiKeyChange": () => ({
          mode: "record",
          changeToken: "test-change-token",
          environmentId: "env-a",
        }),
      },
      "providers",
    );
    negotiateMethods({
      "providers.beginApiKeyChange": { major: 1, minor: 0 },
      "providers.list": { major: 10, minor: 13 },
    });
    await waitFor(() => {
      expect(useAuthStore.getState().contextMetadata?.userId).toBe(
        "team-test-user",
      );
    });
    admitCurrentUserToTeamWindow();
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByText(
        "You can see Acme's settings but not change them.",
      ),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", {
        name: "Claude Code profile: Team viewer profile",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Needs a sign-in")).toBeTruthy();
    await userEvent.click(railButton("Cursor"));
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
  });

  it("keeps transport-written controls read-only on another section for an admin team computer", async () => {
    const harness = mountTeamPageThroughBoundary(
      "admin",
      {
        ...handlers(() => []),
        "environment.configuration.items": () => ({
          items: [
            configurationItem({
              kind: "mcp_server",
              key: "github",
              value: {
                mcpServerId: "srv-1",
                toolToggles: { claude: { search: true } },
              },
              revision: 5,
            }),
          ],
        }),
      },
      "mcp",
    );
    await waitFor(() => {
      expect(useAuthStore.getState().contextMetadata?.userId).toBe(
        "team-test-user",
      );
    });
    admitCurrentUserToTeamWindow();
    render(<TeamMcpServers />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("On")).toBeTruthy();
    expect(
      screen.queryByRole("switch", { name: "github claude search" }),
    ).toBeNull();
    expect(
      screen.getByText("You can see Acme's settings but not change them."),
    ).toBeTruthy();
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
  });

  it.each([
    { flow: "add", awaitMinor: 4, proceeds: false },
    { flow: "add", awaitMinor: 5, proceeds: true },
    { flow: "reauth", awaitMinor: 4, proceeds: false },
    { flow: "reauth", awaitMinor: 5, proceeds: true },
  ] as const)(
    "requires awaitLogin 2.5 for team $flow (minor $awaitMinor)",
    async ({ flow, awaitMinor, proceeds }) => {
      teamProfileRecordHttpBoundary.list = {
        status: 200,
        body: teamProfileRecordsBody(
          flow === "reauth"
            ? [
                teamProfileRecord({
                  profileId: "team-login-profile",
                  harnessId: "claude",
                  name: "Team login profile",
                  readerLabel: "live",
                  kind: "oauth_code",
                }),
              ]
            : [],
        ),
      };
      const harness = mountTeamPageThroughBoundary(
        "admin",
        {
          ...handlers(() => []),
          "environment.host.list": () => ({ hosts: [reachableHost] }),
          "providers.list": () => ({
            providers: [claudeLoginProviderRow()],
            native: null,
            offersSignIns: true,
          }),
          "providers.startLogin": () => ({
            ...teamLoginStartedAnswer(),
          }),
          "providers.awaitLogin": () =>
            teamAwaitLoginOutcomeAnswer({ kind: "waiting-for-profile" }),
        },
        "providers",
      );
      negotiateMethods({
        "providers.startLogin": { major: 1, minor: 5 },
        "providers.awaitLogin": { major: 2, minor: awaitMinor },
      });
      await waitFor(() => {
        expect(useAuthStore.getState().contextMetadata?.userId).toBe(
          "team-test-user",
        );
      });
      admitCurrentUserToTeamWindow();
      render(<TeamProviders />, { wrapper: harness.Wrapper });

      const entry = await screen.findByRole("button", {
        name: flow === "add" ? "Add a profile" : "Sign in again",
      });
      await userEvent.click(entry);
      const dialog = await screen.findByRole("dialog", {
        name: flow === "add" ? "Add a profile" : "Sign in again",
      });
      if (!proceeds) {
        expect(
          within(dialog).getByText(
            "This computer can't sign in for Acme. Use another computer.",
          ),
        ).toBeTruthy();
        expect(
          within(dialog).getByRole("button", { name: "Done" }),
        ).toBeTruthy();
        expect(harness.paramsOf("providers.startLogin")).toEqual([]);
        return;
      }
      if (flow === "add") {
        await userEvent.click(
          within(dialog).getByRole("button", { name: "Sign in" }),
        );
      }
      await waitFor(() => {
        expect(harness.paramsOf("providers.startLogin")).toHaveLength(1);
      });
      expect(harness.paramsOf("providers.startLogin")).toMatchObject([
        {
          target: {
            kind: "environment",
            environmentId: "env-a",
            profileId: flow === "add" ? null : "team-login-profile",
          },
        },
      ]);
      expect(harness.paramsOf("providers.awaitLogin")).toHaveLength(1);
    },
  );

  it("shows the existing offer-refused sentence without server text in the team Add dialog", async () => {
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([]),
    };
    const harness = mountTeamPageThroughBoundary(
      "admin",
      {
        ...handlers(() => []),
        "environment.host.list": () => ({ hosts: [reachableHost] }),
        "providers.list": () => ({
          providers: [claudeLoginProviderRow()],
          native: null,
          offersSignIns: true,
        }),
        "providers.startLogin": () => teamLoginStartedAnswer(),
        "providers.awaitLogin": () =>
          teamAwaitLoginOutcomeAnswer({
            kind: "target-refused",
            reason: "offer-refused",
          }),
      },
      "providers",
    );
    negotiateMethods({
      "providers.startLogin": { major: 1, minor: 5 },
      "providers.awaitLogin": { major: 2, minor: 5 },
    });
    await waitFor(() => {
      expect(useAuthStore.getState().contextMetadata?.userId).toBe(
        "team-test-user",
      );
    });
    admitCurrentUserToTeamWindow();
    render(<TeamProviders />, { wrapper: harness.Wrapper });
    await userEvent.click(
      await screen.findByRole("button", { name: "Add a profile" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Add a profile",
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in" }),
    );

    expect(
      await screen.findByText(
        "This account couldn't be added to Acme. Nothing was changed.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("profile_record_offer_id_live")).toBeNull();
    expect(harness.paramsOf("providers.startLogin")).toHaveLength(1);
    expect(harness.paramsOf("providers.awaitLogin")).toHaveLength(1);
    expect(harness.paramsOf("providers.cancelLogin")).toEqual([]);
  });

  it.each([
    {
      label: "permission was removed",
      status: 403,
      body: null,
      message: "Only admins and editors of Acme can sign in for it.",
    },
    {
      label: "session ended",
      status: 401,
      body: null,
      message: "Sign-in did not finish. Retry when you are ready.",
    },
    {
      label: "the request was unavailable",
      status: 503,
      body: null,
      message: "Acme can't take this sign-in right now. Nothing was changed.",
    },
    {
      label: "the request was already recorded",
      status: 409,
      body: { code: "move_acceptance_conflict" },
      message: "Sign-in did not finish. Retry when you are ready.",
    },
  ])(
    "shows the team's existing recording ending for $label through the shared await",
    async ({ status, body, message }) => {
      teamProfileRecordHttpBoundary.list = {
        status: 200,
        body: teamProfileRecordsBody([]),
      };
      teamProfileRecordHttpBoundary.signInIntent = { status, body };
      const awaitCalls: unknown[] = [];
      const harness = mountTeamPageThroughBoundary(
        "admin",
        {
          ...handlers(() => []),
          "environment.host.list": () => ({ hosts: [reachableHost] }),
          "providers.list": () => ({
            providers: [claudeLoginProviderRow()],
            native: null,
            offersSignIns: true,
          }),
          "providers.startLogin": () => teamLoginStartedAnswer(),
          "providers.awaitLogin": (request) => {
            awaitCalls.push(request);
            return teamAwaitLoginSignInRequestAnswer();
          },
        },
        "providers",
      );
      negotiateMethods({
        "providers.startLogin": { major: 1, minor: 5 },
        "providers.awaitLogin": { major: 2, minor: 5 },
      });
      await waitFor(() => {
        expect(useAuthStore.getState().contextMetadata?.userId).toBe(
          "team-test-user",
        );
      });
      admitCurrentUserToTeamWindow();
      render(<TeamProviders />, { wrapper: harness.Wrapper });
      await userEvent.click(
        await screen.findByRole("button", { name: "Add a profile" }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: "Add a profile",
      });
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Sign in" }),
      );

      expect(await screen.findByText(message)).toBeTruthy();
      expect(awaitCalls).toHaveLength(1);
      expect(harness.paramsOf("providers.startLogin")).toHaveLength(1);
      expect(harness.paramsOf("providers.cancelLogin")).toEqual([]);
      expect(
        teamProfileRecordHttpBoundary.calls.filter((call) =>
          call.url.endsWith(
            "/api/v3/environments/env-a/profile-records/intents",
          ),
        ),
      ).toEqual([
        {
          url: "http://localhost:5005/api/v3/environments/env-a/profile-records/intents",
          method: "POST",
          hasBearerAuthorization: true,
          body: null,
        },
      ]);
    },
  );

  it.each(["Done", "Close"] as const)(
    "closes the completed sign-in waiting footer by %s, then reads one ordinary team row",
    async (closeWith) => {
      teamProfileRecordHttpBoundary.list = {
        status: 200,
        body: teamProfileRecordsBody([]),
      };
      let awaits = 0;
      const harness = mountTeamPageThroughBoundary(
        "admin",
        {
          ...handlers(() => []),
          "environment.host.list": () => ({ hosts: [reachableHost] }),
          "providers.list": () => ({
            providers: [claudeLoginProviderRow()],
            native: null,
            offersSignIns: true,
          }),
          "providers.startLogin": () => teamLoginStartedAnswer(),
          "providers.awaitLogin": () => {
            awaits += 1;
            return awaits === 1
              ? teamAwaitLoginSignInRequestAnswer()
              : teamAwaitLoginOutcomeAnswer({ kind: "waiting-for-profile" });
          },
        },
        "providers",
      );
      negotiateMethods({
        "providers.startLogin": { major: 1, minor: 5 },
        "providers.awaitLogin": { major: 2, minor: 5 },
      });
      await waitFor(() => {
        expect(useAuthStore.getState().contextMetadata?.userId).toBe(
          "team-test-user",
        );
      });
      admitCurrentUserToTeamWindow();
      render(<TeamProviders />, { wrapper: harness.Wrapper });
      await userEvent.click(
        await screen.findByRole("button", { name: "Add a profile" }),
      );
      const addDialog = await screen.findByRole("dialog", {
        name: "Add a profile",
      });
      await userEvent.click(
        within(addDialog).getByRole("button", { name: "Sign in" }),
      );

      expect(await screen.findByText(WAITING_FOR_PROFILE_TEXT)).toBeTruthy();
      await waitFor(() => {
        expect(harness.paramsOf("providers.awaitLogin")).toHaveLength(2);
      });
      expect(teamProfileRecordReadCount()).toBe(1);
      const awaitRequests = harness.paramsOf("providers.awaitLogin");
      expect(awaitRequests[0]).not.toHaveProperty("recordedOperationId");
      expect(awaitRequests[1]).toHaveProperty(
        "recordedOperationId",
        "11111111-1111-4111-8111-111111111111",
      );
      const footer = screen.getByRole("dialog", { name: "Add a profile" });
      await userEvent.click(
        within(footer).getByRole("button", { name: closeWith }),
      );
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(harness.paramsOf("providers.cancelLogin")).toEqual([]);

      teamProfileRecordHttpBoundary.list = {
        status: 200,
        body: teamProfileRecordsBody([
          teamProfileRecord({
            profileId: "team-completed-profile",
            harnessId: "claude",
            name: "Team account ready",
            readerLabel: "live",
            kind: "oauth_code",
          }),
        ]),
      };
      fireEvent.focus(window);
      expect(
        await screen.findByRole("button", {
          name: "Claude Code profile: Team account ready",
        }),
      ).toBeTruthy();
      expect(teamProfileRecordReadCount()).toBe(2);
      expect(harness.paramsOf("providers.startLogin")).toHaveLength(1);
      expect(harness.paramsOf("providers.awaitLogin")).toHaveLength(2);
      expect(harness.paramsOf("providers.cancelLogin")).toEqual([]);
    },
  );

  it("reads only team records through the real boundary and verified app session", async () => {
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([
        teamProfileRecord({
          profileId: "team-signed-in",
          harnessId: "claude",
          name: "Team signed in",
          readerLabel: "live",
          kind: "oauth_code",
        }),
        teamProfileRecord({
          profileId: "team-needs-sign-in",
          harnessId: "claude",
          name: "Team needs sign-in",
          readerLabel: "needs-sign-in",
          kind: "oauth_code",
        }),
        teamProfileRecord({
          profileId: "team-waiting",
          harnessId: "claude",
          name: "Team waiting",
          readerLabel: "waiting",
          kind: "oauth_code",
        }),
        teamProfileRecord({
          profileId: "team-api-key",
          harnessId: "claude",
          name: "Team API key",
          readerLabel: "live",
          kind: "api_key",
        }),
        teamProfileRecord({
          profileId: "future-provider-only",
          harnessId: "future-provider",
          name: "Future provider only",
          readerLabel: "live",
          kind: "oauth_code",
        }),
      ]),
    };
    const harness = mountTeamPageThroughBoundary(
      "editor",
      {
        ...handlers(() => []),
        "environment.host.list": () => ({ hosts: [reachableHost] }),
      },
      "providers",
    );
    await waitFor(() => {
      expect(useAuthStore.getState().contextMetadata?.userId).toBe(
        "team-test-user",
      );
    });
    admitCurrentUserToTeamWindow();
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const trigger = await screen.findByRole("button", {
      name: "Claude Code profile: Team signed in",
    });
    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a profile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage" })).toBeTruthy();

    await userEvent.click(trigger);
    expect(screen.getByText("Team needs sign-in")).toBeTruthy();
    expect(screen.getByText("Needs a sign-in")).toBeTruthy();
    expect(screen.getByText("Team waiting")).toBeTruthy();
    expect(screen.getByText("Waiting for Traycer")).toBeTruthy();
    expect(screen.getByText("Team API key")).toBeTruthy();
    expect(screen.queryByText("Future provider only")).toBeNull();

    const profileReads = teamProfileRecordHttpBoundary.calls.filter((call) =>
      call.url.endsWith("/api/v3/environments/env-a/profile-records"),
    );
    expect(profileReads).toEqual([
      {
        url: "http://localhost:5005/api/v3/environments/env-a/profile-records",
        method: "GET",
        hasBearerAuthorization: true,
        body: null,
      },
    ]);
    expect(
      harness.messenger.calls.filter(
        (call) => call.method === "environment.providers.list",
      ),
    ).toEqual([]);
  });

  it("keeps legacy profile rows when the broker disables shared records", async () => {
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: { enabled: false },
    };
    const harness = mountTeamPageThroughBoundary(
      "editor",
      {
        ...handlers(() => [profile(true, 4)]),
        "environment.host.list": () => ({ hosts: [reachableHost] }),
      },
      "providers",
    );
    await waitFor(() => {
      expect(useAuthStore.getState().contextMetadata?.userId).toBe(
        "team-test-user",
      );
    });
    admitCurrentUserToTeamWindow();
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByRole("button", {
        name: profileTriggerName("Work", false),
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a profile" })).toBeNull();
    expect(
      teamProfileRecordHttpBoundary.calls.filter((call) =>
        call.url.endsWith("/api/v3/environments/env-a/profile-records"),
      ),
    ).toHaveLength(1);
  });

  it("retries a failed team profile read through the real boundary", async () => {
    teamProfileRecordHttpBoundary.list = {
      status: 500,
      body: { enabled: false },
    };
    const harness = mountTeamPageThroughBoundary(
      "editor",
      {
        ...handlers(() => []),
        "environment.host.list": () => ({ hosts: [reachableHost] }),
      },
      "providers",
    );
    await waitFor(() => {
      expect(useAuthStore.getState().contextMetadata?.userId).toBe(
        "team-test-user",
      );
    });
    admitCurrentUserToTeamWindow();
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByText(PROVIDER_STATE_UNREADABLE_COPY),
    ).toBeTruthy();
    const unreadable = screen.getByText(PROVIDER_STATE_UNREADABLE_COPY);
    const readFailureLine = unreadable.closest('[role="status"]');
    expect(readFailureLine).not.toBeNull();
    if (readFailureLine === null)
      throw new Error("expected the provider read status line");
    const retry = within(readFailureLine).getByRole("button", {
      name: "Retry",
    });
    expect(
      teamProfileRecordHttpBoundary.calls.filter((call) =>
        call.url.endsWith("/api/v3/environments/env-a/profile-records"),
      ),
    ).toHaveLength(1);

    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([
        teamProfileRecord({
          profileId: "team-read-recovered",
          harnessId: "claude",
          name: "Team read recovered",
          readerLabel: "live",
          kind: "oauth_code",
        }),
      ]),
    };
    await userEvent.click(retry);
    expect(
      await screen.findByRole("button", {
        name: "Claude Code profile: Team read recovered",
      }),
    ).toBeTruthy();
    expect(
      teamProfileRecordHttpBoundary.calls.filter((call) =>
        call.url.endsWith("/api/v3/environments/env-a/profile-records"),
      ),
    ).toHaveLength(2);
  });

  it("keeps the negotiated 10.11 computer provider path separate from team profile reads", async () => {
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: { enabled: false },
    };
    negotiateMethods({ "providers.list": { major: 10, minor: 11 } });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [profile(true, 4)]),
      "environment.host.list": () => ({
        hosts: [{ ...reachableHost, hostId: WINDOW_HOST_ID, kind: "team" }],
      }),
      "providers.list": () => ({
        providers: [
          {
            ...claudeLoginProviderRow(),
            profiles: [
              teamProviderProfile({
                profileId: "computer-profile",
                label: "Computer profile",
                authStatus: "authenticated",
                personNotice: null,
                apiKeyConfigured: false,
              }),
            ],
          },
        ],
        native: null,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByRole("button", {
        name: profileTriggerName("Work", false),
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Computer profile")).toBeNull();
    expect(harness.paramsOf("providers.list")).toEqual([{ native: null }]);
    expect(
      harness.messenger.calls.filter(
        (call) => call.method === "environment.providers.list",
      ),
    ).toEqual([]);
  });

  it("keeps the empty synced state and Add affordance for an editor", async () => {
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([]),
    };
    const harness = mountTeamPageThroughBoundary(
      "editor",
      {
        ...handlers(() => []),
        "environment.host.list": () => ({ hosts: [reachableHost] }),
      },
      "providers",
    );
    await waitFor(() => {
      expect(useAuthStore.getState().contextMetadata?.userId).toBe(
        "team-test-user",
      );
    });
    admitCurrentUserToTeamWindow();
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("No profiles yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a profile" })).toBeTruthy();
    expect(
      teamProfileRecordHttpBoundary.calls.filter((call) =>
        call.url.endsWith("/api/v3/environments/env-a/profile-records"),
      ),
    ).toHaveLength(1);
  });

  it("keeps Personal Providers on its existing rows without a profile-record request", async () => {
    const harness = mountPersonalProvidersThroughBoundary({
      ...handlers(() => [profile(true, 4)]),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByRole("button", {
        name: profileTriggerName("Work", false),
      }),
    ).toBeTruthy();
    expect(
      teamProfileRecordHttpBoundary.calls.filter((call) =>
        call.url.includes("/profile-records"),
      ),
    ).toEqual([]);
  });

  it("keeps the plan label, standing and quota while synced team admins lose Link and Unlink", async () => {
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([
        teamProfileRecord({
          profileId: "team-plan-row",
          harnessId: "claude",
          name: "Team plan row",
          readerLabel: "live",
          kind: "oauth_code",
        }),
      ]),
    };
    const harness = mountTeamPageThroughBoundary(
      "admin",
      {
        ...handlers(() => []),
        "environment.host.list": () => ({ hosts: [reachableHost] }),
        "environment.plans.list": () => ({
          plans: [
            {
              profileId: "plan-claude",
              harness: "claude",
              status: "linked" as const,
              linkedBy: { name: "Ada", you: false },
            },
          ],
        }),
      },
      "providers",
    );
    await waitFor(() => {
      expect(useAuthStore.getState().contextMetadata?.userId).toBe(
        "team-test-user",
      );
    });
    admitCurrentUserToTeamWindow();
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const plans = await screen.findByRole("region", { name: "Plans" });
    expect(
      within(plans).getByRole("combobox", { name: "Linked plan" }),
    ).toBeTruthy();
    expect(within(plans).getByText("Signed in")).toBeTruthy();
    expect(
      within(plans).getByText(
        "Shared Claude Code quota. Sandbox charges use Acme credits.",
      ),
    ).toBeTruthy();
    expect(
      within(plans).queryByRole("button", { name: "Link a plan" }),
    ).toBeNull();
    expect(within(plans).queryByRole("button", { name: "Unlink" })).toBeNull();
    expect(within(plans).queryByText(/tier/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Add a profile" })).toBeTruthy();
    const planRequests = harness.paramsOf("environment.plans.list");
    expect(planRequests.length).toBeGreaterThan(0);
    expect(
      planRequests.every((request) => request.environmentId === "env-a"),
    ).toBe(true);
  });

  it("keeps the last team account removal confirmation after an uncoded failure and permits a manual retry", async () => {
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([
        teamProfileRecord({
          profileId: "last-team-account",
          harnessId: "claude",
          name: "Last team account",
          readerLabel: "live",
          kind: "oauth_code",
        }),
      ]),
    };
    teamProfileRecordHttpBoundary.action = { status: 500, body: null };
    const harness = mountTeamPageThroughBoundary(
      "admin",
      {
        ...handlers(() => []),
        "environment.host.list": () => ({ hosts: [reachableHost] }),
        "providers.list": () => ({
          providers: [claudeLoginProviderRow()],
          native: null,
        }),
      },
      "providers",
    );
    await waitFor(() => {
      expect(useAuthStore.getState().contextMetadata?.userId).toBe(
        "team-test-user",
      );
    });
    admitCurrentUserToTeamWindow();
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: "Claude Code profile: Last team account",
    });
    const editor = await openProfileEditor();
    await userEvent.click(
      within(editor).getByRole("button", { name: "Remove profile" }),
    );
    let confirmation = await screen.findByRole("dialog", {
      name: "Remove Last team account?",
    });
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "Remove" }),
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Couldn't remove profile.");
      expect(teamProfileRecordReadCount()).toBe(2);
    });
    confirmation = screen.getByRole("dialog", {
      name: "Remove Last team account?",
    });
    expect(
      teamProfileRecordHttpBoundary.calls.filter(
        (call) =>
          call.url.endsWith("/profile-records/last-team-account/remove") &&
          call.method === "POST",
      ),
    ).toHaveLength(1);
    await waitFor(() => {
      expect(
        teamProfileRecordHttpBoundary.calls.filter(
          (call) =>
            call.url.endsWith("/api/v3/environments/env-a/profile-records") &&
            call.method === "GET",
        ),
      ).toHaveLength(2);
    });

    teamProfileRecordHttpBoundary.action = {
      status: 200,
      body: {
        profileId: "last-team-account",
        harnessId: "claude",
        recordRevision: "2",
      },
    };
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => {
      expect(
        teamProfileRecordHttpBoundary.calls.filter(
          (call) =>
            call.url.endsWith("/profile-records/last-team-account/remove") &&
            call.method === "POST",
        ),
      ).toHaveLength(2);
    });
    await waitFor(() => {
      expect(
        teamProfileRecordHttpBoundary.calls.filter(
          (call) =>
            call.url.endsWith("/api/v3/environments/env-a/profile-records") &&
            call.method === "GET",
        ),
      ).toHaveLength(3);
    });
    expect(
      screen.queryByRole("dialog", { name: "Remove Last team account?" }),
    ).toBeNull();
  });

  it("keeps sign-out confirmation after an uncoded failure and permits a manual retry", async () => {
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([
        teamProfileRecord({
          profileId: "team-sign-out-profile",
          harnessId: "claude",
          name: "Team sign-out profile",
          readerLabel: "live",
          kind: "oauth_code",
        }),
      ]),
    };
    teamProfileRecordHttpBoundary.action = { status: 500, body: null };
    const harness = mountTeamPageThroughBoundary(
      "admin",
      {
        ...handlers(() => []),
        "environment.host.list": () => ({ hosts: [reachableHost] }),
      },
      "providers",
    );
    await waitFor(() => {
      expect(useAuthStore.getState().contextMetadata?.userId).toBe(
        "team-test-user",
      );
    });
    admitCurrentUserToTeamWindow();
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: "Claude Code profile: Team sign-out profile",
    });
    const editor = await openProfileEditor();
    await userEvent.click(
      within(editor).getByRole("button", { name: "Sign out" }),
    );
    let confirmation = await screen.findByRole("dialog", {
      name: "Sign out of Team sign-out profile in Acme?",
    });
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "Sign out" }),
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Couldn't sign out.");
      expect(teamProfileRecordReadCount()).toBe(2);
    });
    confirmation = screen.getByRole("dialog", {
      name: "Sign out of Team sign-out profile in Acme?",
    });
    expect(
      teamProfileRecordHttpBoundary.calls.filter(
        (call) =>
          call.url.endsWith(
            "/api/v3/environments/env-a/profile-records/team-sign-out-profile/sign-out",
          ) && call.method === "POST",
      ),
    ).toHaveLength(1);

    teamProfileRecordHttpBoundary.action = {
      status: 200,
      body: {
        profileId: "team-sign-out-profile",
        harnessId: "claude",
        recordRevision: "2",
      },
    };
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "Sign out" }),
    );
    await waitFor(() => {
      expect(teamProfileRecordReadCount()).toBe(3);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(
      teamProfileRecordHttpBoundary.calls.filter(
        (call) =>
          call.url.endsWith(
            "/api/v3/environments/env-a/profile-records/team-sign-out-profile/sign-out",
          ) && call.method === "POST",
      ),
    ).toHaveLength(2);
  });

  it("keeps a rename editor open after an uncoded failure and permits a manual retry", async () => {
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([
        teamProfileRecord({
          profileId: "team-rename-profile",
          harnessId: "claude",
          name: "Team rename profile",
          readerLabel: "live",
          kind: "oauth_code",
        }),
      ]),
    };
    teamProfileRecordHttpBoundary.action = { status: 500, body: null };
    const harness = mountTeamPageThroughBoundary(
      "admin",
      {
        ...handlers(() => []),
        "environment.host.list": () => ({ hosts: [reachableHost] }),
      },
      "providers",
    );
    await waitFor(() => {
      expect(useAuthStore.getState().contextMetadata?.userId).toBe(
        "team-test-user",
      );
    });
    admitCurrentUserToTeamWindow();
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: "Claude Code profile: Team rename profile",
    });
    let editor = await openProfileEditor();
    fireEvent.change(within(editor).getByLabelText("Profile name"), {
      target: { value: "Team renamed profile" },
    });
    await userEvent.click(
      within(editor).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Couldn't rename profile.");
      expect(teamProfileRecordReadCount()).toBe(2);
    });
    editor = screen.getByRole("dialog", { name: "Edit profile" });
    expect(
      teamProfileRecordHttpBoundary.calls.filter(
        (call) =>
          call.url.endsWith(
            "/api/v3/environments/env-a/profile-records/team-rename-profile/name",
          ) && call.method === "POST",
      ),
    ).toHaveLength(1);

    teamProfileRecordHttpBoundary.action = {
      status: 200,
      body: {
        profileId: "team-rename-profile",
        harnessId: "claude",
        recordRevision: "2",
        name: "Team renamed profile",
      },
    };
    await userEvent.click(
      within(editor).getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() => {
      expect(teamProfileRecordReadCount()).toBe(3);
      expect(screen.queryByRole("dialog", { name: "Edit profile" })).toBeNull();
    });
    expect(
      teamProfileRecordHttpBoundary.calls.filter(
        (call) =>
          call.url.endsWith(
            "/api/v3/environments/env-a/profile-records/team-rename-profile/name",
          ) && call.method === "POST",
      ),
    ).toHaveLength(2);
  });

  it.each([
    {
      label: "permission refusal",
      status: 403,
      message: "You don't have permission to do that.",
    },
    {
      label: "missing environment",
      status: 404,
      message: "Couldn't update profile availability.",
    },
  ])(
    "shows the existing team switch failure for $label through AuthService",
    async ({ status, message }) => {
      teamProfileRecordHttpBoundary.list = {
        status: 200,
        body: teamProfileRecordsBody([
          teamProfileRecord({
            profileId: "team-switch-profile",
            harnessId: "claude",
            name: "Team switch profile",
            readerLabel: "live",
            kind: "oauth_code",
          }),
        ]),
      };
      teamProfileRecordHttpBoundary.items = {
        status: 200,
        body: {
          items: [
            configurationItem({
              kind: "managed_profile",
              key: "claude:team-switch-profile",
              value: {
                name: "Team switch profile",
                color: null,
                harnessId: "claude",
                accountIdentity: null,
                needsLink: false,
                enabled: true,
              },
              revision: 1,
            }),
          ],
        },
      };
      teamProfileRecordHttpBoundary.itemWriteStatus = status;
      const harness = mountTeamPageThroughBoundary(
        "admin",
        {
          ...handlers(() => []),
          "environment.host.list": () => ({ hosts: [reachableHost] }),
        },
        "providers",
      );
      await waitFor(() => {
        expect(useAuthStore.getState().contextMetadata?.userId).toBe(
          "team-test-user",
        );
      });
      admitCurrentUserToTeamWindow();
      render(<TeamProviders />, { wrapper: harness.Wrapper });

      await screen.findByRole("button", {
        name: "Claude Code profile: Team switch profile",
      });
      openProfileMenu(profileTriggerName("Team switch profile", false));
      await userEvent.click(profileRowSwitch("Team switch profile"));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(message);
        expect(teamProfileRecordReadCount()).toBe(2);
      });
      expect(
        teamProfileRecordHttpBoundary.calls.some(
          (call) =>
            call.url.endsWith(
              "/api/v3/environments/env-a/items/managed_profile",
            ) && call.method === "PUT",
        ),
      ).toBe(true);
    },
  );

  it("shows the existing write-refusal line for an admin colour change through the real boundary", async () => {
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([
        teamProfileRecord({
          profileId: "team-color-profile",
          harnessId: "claude",
          name: "Team color profile",
          readerLabel: "live",
          kind: "oauth_code",
        }),
      ]),
    };
    teamProfileRecordHttpBoundary.items = {
      status: 200,
      body: {
        items: [
          {
            kind: "managed_profile",
            key: "claude:team-color-profile",
            value: {
              name: "Team color profile",
              color: null,
              harnessId: "claude",
              accountIdentity: null,
              needsLink: false,
              enabled: true,
            },
            revision: 1,
          },
        ],
      },
    };
    teamProfileRecordHttpBoundary.itemWriteStatus = 403;
    const harness = mountTeamPageThroughBoundary(
      "admin",
      {
        ...handlers(() => []),
        "environment.host.list": () => ({ hosts: [reachableHost] }),
      },
      "providers",
    );
    await waitFor(() => {
      expect(useAuthStore.getState().contextMetadata?.userId).toBe(
        "team-test-user",
      );
    });
    admitCurrentUserToTeamWindow();
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: "Claude Code profile: Team color profile",
    });
    const editor = await openProfileEditor();
    await userEvent.click(
      within(editor).getByRole("button", { name: "Use color #3b82f6" }),
    );
    await userEvent.click(
      within(editor).getByRole("button", { name: "Save changes" }),
    );

    expect(
      await screen.findByText(
        "You no longer have access to change these settings.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Edit profile" })).toBeTruthy();
    expect(
      teamProfileRecordHttpBoundary.calls.some(
        (call) =>
          call.url.includes(
            "/api/v3/environments/env-a/items/managed_profile",
          ) && call.method === "PUT",
      ),
    ).toBe(true);
  });

  it("updates a synced row through its exact managed-profile item key and rereads records", async () => {
    const stored = {
      name: "Shared Work",
      color: null,
      harnessId: "claude",
      accountIdentity: "Shared identity",
      needsLink: false,
      enabled: true,
      mergedInto: "canonical-shared-work",
    };
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([
        teamProfileRecord({
          profileId: "profile.with.dots",
          harnessId: "claude",
          name: stored.name,
          readerLabel: "live",
          kind: "oauth_code",
        }),
      ]),
    };
    teamProfileRecordHttpBoundary.items = {
      status: 200,
      body: {
        items: [
          {
            kind: "managed_profile",
            key: "claude:profile.with.dots",
            value: stored,
            revision: 9,
          },
        ],
      },
    };
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers(() => []),
    );
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const enabledSwitch = await screen.findByRole("switch", {
      name: "Allow agents to use Shared Work",
    });
    await userEvent.click(enabledSwitch);

    const itemWrites = teamProfileRecordHttpBoundary.calls.filter(
      (call) =>
        call.url.endsWith("/api/v3/environments/env-a/items/managed_profile") &&
        call.method === "PUT",
    );
    expect(itemWrites).toEqual([
      {
        url: "http://localhost:5005/api/v3/environments/env-a/items/managed_profile",
        method: "PUT",
        hasBearerAuthorization: true,
        body: JSON.stringify({
          key: "claude:profile.with.dots",
          os: null,
          value: { ...stored, enabled: false },
          revision: 9,
          upload: null,
        }),
      },
    ]);
    const profileReads = teamProfileRecordHttpBoundary.calls.filter(
      (call) =>
        call.url.endsWith("/api/v3/environments/env-a/profile-records") &&
        call.method === "GET",
    );
    expect(profileReads).toHaveLength(2);
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
  });

  it("does not label an editor profile control Use", async () => {
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers(() => [profile(true, 4)]),
    );
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("Work")).toBeTruthy();
    expect(screen.queryByText("Use")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Use Work" })).toBeNull();
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
  });

  it("lists every team profile and writes each row switch with that item's revision and stored record", async () => {
    const workValue = {
      name: "Work",
      color: null,
      harnessId: "claude",
      accountIdentity: "Work label",
      needsLink: false,
      enabled: true,
      mergedInto: "kept-work",
    };
    const homeValue = {
      name: "Home",
      color: null,
      harnessId: "claude",
      accountIdentity: "Home label",
      needsLink: false,
      enabled: true,
      mergedInto: "kept-home",
    };
    const work = configurationItem({
      kind: "managed_profile",
      key: "claude:work",
      value: workValue,
      revision: 4,
    });
    const home = configurationItem({
      kind: "managed_profile",
      key: "claude:home",
      value: homeValue,
      revision: 9,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work, home]),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 10,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const trigger = await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const account = screen.getByText("Work label");
    expect(
      trigger.compareDocumentPosition(account) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("Home label")).toBeNull();
    openProfileMenu(profileTriggerName("Work", false));
    const workRow = screen.getByRole("menuitem", { name: "Work" });
    const homeRow = screen.getByRole("menuitem", { name: "Home" });
    expect(
      workRow.compareDocumentPosition(homeRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: "Add a profile" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a profile" })).toBeNull();

    fireEvent.click(profileRowSwitch("Home"));
    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:home",
          os: null,
          value: { ...homeValue, enabled: false },
          revision: 9,
        },
      ]);
    });
    fireEvent.click(profileRowSwitch("Work"));
    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:home",
          os: null,
          value: { ...homeValue, enabled: false },
          revision: 9,
        },
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: { ...workValue, enabled: false },
          revision: 4,
        },
      ]);
    });
  });

  it("toggles a profile against the displayed revision, and a conflict rereads it beside the changed-by line", async () => {
    let current = teamProfile({
      key: "claude:prof-1",
      name: "Work",
      revision: 4,
      enabled: true,
      mergedInto: "kept-work",
      accountIdentity: null,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [current]),
      "environment.configuration.items.put": () => {
        current = teamProfile({
          key: "claude:prof-1",
          name: "Work",
          revision: 5,
          enabled: false,
          mergedInto: "kept-work",
          accountIdentity: null,
        });
        return {
          outcome: "conflict",
          current: { revision: 5, changedBy: "Grace", changedAt: 2 },
        };
      },
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("Work")).toBeTruthy();
    const checkboxItem = screen.getByRole("switch", {
      name: "Allow agents to use Work",
    });
    expect(checkboxItem.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(checkboxItem);

    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "managed_profile",
        key: "claude:prof-1",
        os: null,
        value: {
          name: "Work",
          color: null,
          harnessId: "claude",
          accountIdentity: null,
          needsLink: false,
          enabled: false,
          mergedInto: "kept-work",
        },
        revision: 4,
      },
    ]);
    expect(
      await screen.findByText("Changed by Grace a moment ago"),
    ).toBeTruthy();
    expect(screen.queryByText("Off")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: profileTriggerName("Work", true),
      }),
    ).toBeTruthy();
    await waitFor(() => {
      const updatedCheckboxItem = screen.getByRole("switch", {
        name: "Allow agents to use Work",
      });
      expect(updatedCheckboxItem.getAttribute("aria-checked")).toBe("false");
    });
  });

  it("gives a viewer On/Off for a profile with no switch, plus the member-only verbs withheld", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      ...handlers(() => [profile(true, 4)]),
      "environment.secrets.list": () => ({
        secrets: [
          cursorKey,
          { ...cursorKey, secretId: "second-key", name: "OPENAI_API_KEY" },
        ],
        removed: [],
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const identity = await screen.findByText("ada@example.com");
    expect(identity.className).toContain("whitespace-normal");
    expect(identity.className).toContain("break-words");
    expect(screen.queryByText("Off")).toBeNull();
    expect(screen.queryByText("Use")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Key" })).toBeNull();
    expect(screen.queryByText("CURSOR_API_KEY")).toBeNull();
    expect(screen.getByText("On")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    expect(screen.queryByText("Signed in")).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a key" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Secrets" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Profile" })).toBeNull();
    expect(
      screen.getByRole("button", { name: profileTriggerName("Work", false) }),
    ).toBeTruthy();
  });

  it("lets a reader select a disabled profile and keeps On or Off with no Manage", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      ...handlers(() => [
        teamProfile({
          key: "claude:work",
          name: "Work",
          revision: 4,
          enabled: true,
          mergedInto: "kept-work",
          accountIdentity: "Work label",
        }),
        teamProfile({
          key: "claude:home",
          name: "Home",
          revision: 8,
          enabled: false,
          mergedInto: "kept-home",
          accountIdentity: "Home label",
        }),
      ]),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    expect(screen.queryByRole("button", { name: "Manage profile" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    openProfileMenu(profileTriggerName("Work", false));
    const homeGroup = screen.getByRole("group", {
      name: "Home profile controls",
    });
    expect(within(homeGroup).getByText("Off")).toBeTruthy();
    expect(within(homeGroup).queryByRole("switch")).toBeNull();
    const homeRow = within(homeGroup).getByRole("menuitem", {
      name: "Home, Disabled",
    });
    expect(homeRow.getAttribute("aria-disabled")).not.toBe("true");
    const workGroup = screen.getByRole("group", {
      name: "Work profile controls",
    });
    expect(within(workGroup).getByText("On")).toBeTruthy();
    expect(within(workGroup).queryByRole("switch")).toBeNull();
    fireEvent.click(homeRow);

    expect(
      await screen.findByRole("button", {
        name: profileTriggerName("Home", true),
      }),
    ).toBeTruthy();
    expect(screen.getByText("Home label")).toBeTruthy();
    expect(screen.queryByText("Work label")).toBeNull();
    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a profile" })).toBeNull();
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
  });

  it("renames the selected profile through Manage and keeps the stored record", async () => {
    const work = teamProfile({
      key: "claude:work",
      name: "Work",
      revision: 4,
      enabled: true,
      mergedInto: "kept-work",
      accountIdentity: "Work label",
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work]),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 5,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    expect(within(dialog).getByText("Update how Work appears.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Profile name"), {
      target: { value: "Desk" },
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: {
            name: "Desk",
            color: null,
            harnessId: "claude",
            accountIdentity: "Work label",
            needsLink: false,
            enabled: true,
            mergedInto: "kept-work",
          },
          revision: 4,
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Edit profile" })).toBeNull();
    });
  });

  it("recolors the selected profile through Manage and warns when another profile uses that color", async () => {
    const sharedColor = "#3b82f6";
    const work = teamProfile({
      key: "claude:work",
      name: "Work",
      revision: 6,
      enabled: true,
      mergedInto: "kept-work",
      accountIdentity: "Work label",
    });
    const home = teamProfile({
      key: "claude:home",
      name: "Home",
      revision: 2,
      enabled: true,
      mergedInto: "kept-home",
      accountIdentity: "Home label",
      color: sharedColor,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work, home]),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 7,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    expect(within(dialog).queryByText(/already uses this color/)).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", { name: `Use color ${sharedColor}` }),
    );
    expect(
      within(dialog).getByText(/Home already uses this color/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: {
            name: "Work",
            color: sharedColor,
            harnessId: "claude",
            accountIdentity: "Work label",
            needsLink: false,
            enabled: true,
            mergedInto: "kept-work",
          },
          revision: 6,
        },
      ]);
    });
  });

  it("removes the selected profile through Manage at its revision", async () => {
    const work = teamProfile({
      key: "claude:work",
      name: "Work",
      revision: 11,
      enabled: true,
      mergedInto: "kept-work",
      accountIdentity: "Work label",
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work]),
      "environment.configuration.items.delete": () => ({
        outcome: "saved",
        revision: null,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove profile" }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: "Remove Work?",
    });
    expect(
      within(confirm).getByText("Remove this profile from the team."),
    ).toBeTruthy();
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Remove" }),
    );

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.delete"),
      ).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          revision: 11,
        },
      ]);
    });
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
  });

  it("refuses a blank profile name and a name past 64 characters, and saves a name at the limit", async () => {
    const work = teamProfile({
      key: "claude:work",
      name: "Work",
      revision: 3,
      enabled: true,
      mergedInto: "kept-work",
      accountIdentity: "Work label",
    });
    const limit = "a".repeat(64);
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work]),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 4,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    const nameField = within(dialog).getByLabelText("Profile name");
    expect(nameField).toHaveProperty("maxLength", 64);
    fireEvent.change(nameField, { target: { value: "   " } });
    expect(
      within(dialog).getByRole("button", { name: "Save changes" }),
    ).toHaveProperty("disabled", true);
    fireEvent.change(nameField, { target: { value: "a".repeat(65) } });
    expect(nameField).toHaveProperty("value", "a".repeat(65));
    expect(
      within(dialog).getByRole("button", { name: "Save changes" }),
    ).toHaveProperty("disabled", true);
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
    fireEvent.change(nameField, { target: { value: limit } });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: {
            name: limit,
            color: null,
            harnessId: "claude",
            accountIdentity: "Work label",
            needsLink: false,
            enabled: true,
            mergedInto: "kept-work",
          },
          revision: 3,
        },
      ]);
    });
  });

  it("leaves the edit dialog open when a rename conflicts", async () => {
    const work = teamProfile({
      key: "claude:work",
      name: "Work",
      revision: 4,
      enabled: true,
      mergedInto: "kept-work",
      accountIdentity: "Work label",
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work]),
      "environment.configuration.items.put": () => ({
        outcome: "conflict",
        current: { revision: 5, changedBy: "Nora", changedAt: 2 },
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    fireEvent.change(within(dialog).getByLabelText("Profile name"), {
      target: { value: "Desk" },
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    expect(
      await screen.findByText("Changed by Nora a moment ago"),
    ).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Edit profile" })).toBeTruthy();
    expect(screen.getByLabelText("Profile name")).toHaveProperty(
      "value",
      "Desk",
    );
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "managed_profile",
        key: "claude:work",
        os: null,
        value: {
          name: "Desk",
          color: null,
          harnessId: "claude",
          accountIdentity: "Work label",
          needsLink: false,
          enabled: true,
          mergedInto: "kept-work",
        },
        revision: 4,
      },
    ]);
    expect(harness.paramsOf("environment.configuration.items.delete")).toEqual(
      [],
    );
  });

  it("retries a rename after a conflict with the colour from the re-read", async () => {
    const stored = {
      name: "Work",
      color: null,
      harnessId: "claude",
      accountIdentity: "Work label",
      needsLink: false,
      enabled: true,
      mergedInto: "kept-work",
    };
    const teammateColor = "#3b82f6";
    const reread = { ...stored, color: teammateColor };
    let current = teamProfile({
      key: "claude:work",
      name: stored.name,
      revision: 4,
      enabled: stored.enabled,
      mergedInto: stored.mergedInto,
      accountIdentity: stored.accountIdentity,
      color: stored.color,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [current]),
      "environment.configuration.items.put": () => {
        if (current.revision === 4) {
          current = teamProfile({
            key: "claude:work",
            name: reread.name,
            revision: 5,
            enabled: reread.enabled,
            mergedInto: reread.mergedInto,
            accountIdentity: reread.accountIdentity,
            color: reread.color,
          });
          return {
            outcome: "conflict",
            current: { revision: 5, changedBy: "Nora", changedAt: 2 },
          };
        }
        return { outcome: "saved", revision: 6 };
      },
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    const reads = harness.paramsOf("environment.configuration.items").length;
    fireEvent.change(within(dialog).getByLabelText("Profile name"), {
      target: { value: "Desk" },
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(
      await screen.findByText("Changed by Nora a moment ago"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items").length,
      ).toBeGreaterThan(reads);
    });
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: { ...stored, name: "Desk" },
          revision: 4,
        },
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: { ...reread, name: "Desk" },
          revision: 5,
        },
      ]);
    });
  });

  it("retries a recolor after a conflict with the name from the re-read", async () => {
    const stored = {
      name: "Work",
      color: null,
      harnessId: "claude",
      accountIdentity: "Work label",
      needsLink: false,
      enabled: true,
      mergedInto: "kept-work",
    };
    const pickedColor = "#ef4444";
    const reread = { ...stored, name: "Home" };
    let current = teamProfile({
      key: "claude:work",
      name: stored.name,
      revision: 4,
      enabled: stored.enabled,
      mergedInto: stored.mergedInto,
      accountIdentity: stored.accountIdentity,
      color: stored.color,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [current]),
      "environment.configuration.items.put": () => {
        if (current.revision === 4) {
          current = teamProfile({
            key: "claude:work",
            name: reread.name,
            revision: 5,
            enabled: reread.enabled,
            mergedInto: reread.mergedInto,
            accountIdentity: reread.accountIdentity,
            color: reread.color,
          });
          return {
            outcome: "conflict",
            current: { revision: 5, changedBy: "Nora", changedAt: 2 },
          };
        }
        return { outcome: "saved", revision: 6 };
      },
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    const reads = harness.paramsOf("environment.configuration.items").length;
    await userEvent.click(
      within(dialog).getByRole("button", { name: `Use color ${pickedColor}` }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(
      await screen.findByText("Changed by Nora a moment ago"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items").length,
      ).toBeGreaterThan(reads);
    });
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: { ...stored, color: pickedColor },
          revision: 4,
        },
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: { ...reread, color: pickedColor },
          revision: 5,
        },
      ]);
    });
  });
});
