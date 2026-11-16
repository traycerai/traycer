import "./team-provider-profiles-test-support";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TeamProviders } from "@/components/settings/environment/team-providers";
import { TeamProfileApiKeyForm } from "@/components/settings/environment/team-profile-api-key-form";
import { WAITING_FOR_PROFILE_TEXT } from "@/components/providers/profile-sync-copy";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  admitCurrentUserToTeamWindow,
  mountTeamPageThroughBoundary,
  recordAppLoggerCalls,
  TEAM_PROFILE_KEY_CANARY,
  teamProfileRecord,
  teamProfileRecordsBody,
  teamProfileRecordHttpBoundary,
  teamAwaitLoginOutcomeAnswer,
  teamAwaitLoginSignInRequestAnswer,
  teamLoginStartedAnswer,
  teamProfileRecordReadCount,
} from "./team-configuration-test-support";
import { negotiateMethods, reachableHost } from "./mcp-skills-test-support";
import {
  handlers,
  claudeLoginProviderRow,
  cursorProviderWithTeamRecordKey,
  teamProviderEnvironmentStatus,
  railButton,
  teamProviderProfile,
} from "./team-providers-test-support";

describe("Team Providers boundary and sign-in", () => {
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
      const appLogs = recordAppLoggerCalls();
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
        logs: appLogs(),
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
    const appLogs = recordAppLoggerCalls();

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
      logs: appLogs(),
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
        expect(teamProfileRecordReadCount()).toBe(1);
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
      expect(teamProfileRecordReadCount()).toBe(2);
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
      expect(teamProfileRecordReadCount()).toBe(2);
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
      expect(teamProfileRecordReadCount()).toBe(2);
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
      expect(teamProfileRecordReadCount()).toBe(3);
      expect(harness.paramsOf("providers.startLogin")).toHaveLength(1);
      expect(harness.paramsOf("providers.awaitLogin")).toHaveLength(2);
      expect(harness.paramsOf("providers.cancelLogin")).toEqual([]);
    },
  );
});
