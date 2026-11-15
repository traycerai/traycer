import "./team-provider-profiles-test-support";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { describe, expect, it } from "vitest";
import { TeamProviders } from "@/components/settings/environment/team-providers";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  admitCurrentUserToTeamWindow,
  mountTeamPageThroughBoundary,
  recordAppLoggerCalls,
  configurationItem,
  teamProfileRecord,
  teamProfileRecordsBody,
  teamProfileRecordHttpBoundary,
  teamProfileRecordReadCount,
  teamAwaitLoginOutcomeAnswer,
  teamLoginStartedAnswer,
  teamPageCachedErrorValues,
} from "./team-configuration-test-support";
import { negotiateMethods, reachableHost } from "./mcp-skills-test-support";
import {
  openProfileEditor,
  handlers,
  claudeLoginProviderRow,
} from "./team-providers-test-support";

const PRIVATE_ACTION_ERROR_CANARY = "private-action-error-canary";

describe("Team provider action failures and result privacy", () => {
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
    teamProfileRecordHttpBoundary.action = {
      status: 500,
      body: { statusCode: 500, error: PRIVATE_ACTION_ERROR_CANARY },
    };
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
    const appLogs = recordAppLoggerCalls();
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
      document.body.textContent.includes(PRIVATE_ACTION_ERROR_CANARY),
    ).toBe(false);
    expect(
      teamPageCachedErrorValues(harness).some((error) =>
        error.includes(PRIVATE_ACTION_ERROR_CANARY),
      ),
    ).toBe(false);
    expect(appLogs().includes(PRIVATE_ACTION_ERROR_CANARY)).toBe(false);
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
    teamProfileRecordHttpBoundary.action = {
      status: 500,
      body: { statusCode: 500, error: PRIVATE_ACTION_ERROR_CANARY },
    };
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
    const appLogs = recordAppLoggerCalls();
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
      document.body.textContent.includes(PRIVATE_ACTION_ERROR_CANARY),
    ).toBe(false);
    expect(
      teamPageCachedErrorValues(harness).some((error) =>
        error.includes(PRIVATE_ACTION_ERROR_CANARY),
      ),
    ).toBe(false);
    expect(appLogs().includes(PRIVATE_ACTION_ERROR_CANARY)).toBe(false);
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
    teamProfileRecordHttpBoundary.action = {
      status: 500,
      body: { statusCode: 500, error: PRIVATE_ACTION_ERROR_CANARY },
    };
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
    const appLogs = recordAppLoggerCalls();
    await userEvent.click(
      within(editor).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Couldn't rename profile.");
      expect(teamProfileRecordReadCount()).toBe(2);
    });
    editor = screen.getByRole("dialog", { name: "Edit profile" });
    expect(
      document.body.textContent.includes(PRIVATE_ACTION_ERROR_CANARY),
    ).toBe(false);
    expect(
      teamPageCachedErrorValues(harness).some((error) =>
        error.includes(PRIVATE_ACTION_ERROR_CANARY),
      ),
    ).toBe(false);
    expect(appLogs().includes(PRIVATE_ACTION_ERROR_CANARY)).toBe(false);
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

  it("keeps a post-add color refusal in the signed-in result through the real boundary", async () => {
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([]),
    };
    teamProfileRecordHttpBoundary.items = {
      status: 200,
      body: {
        items: [
          configurationItem({
            kind: "managed_profile",
            key: "claude:team-created-profile",
            value: {
              name: "New team account",
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
    teamProfileRecordHttpBoundary.itemWriteStatus = 403;
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
          teamProfileRecordHttpBoundary.list = {
            status: 200,
            body: teamProfileRecordsBody([
              teamProfileRecord({
                profileId: "team-created-profile",
                harnessId: "claude",
                name: "New team account",
                readerLabel: "live",
                kind: "oauth_code",
              }),
            ]),
          };
          return teamAwaitLoginOutcomeAnswer({
            kind: "signed-in",
            profileId: "team-created-profile",
          });
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

    expect(
      await within(dialog).findByText(
        "The account was signed in, but the profile color could not be saved.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).queryByText(
        "You no longer have access to change these settings.",
      ),
    ).toBeNull();
    await waitFor(() => {
      expect(
        teamProfileRecordHttpBoundary.calls.filter(
          (call) =>
            call.url.endsWith(
              "/api/v3/environments/env-a/items/managed_profile",
            ) && call.method === "PUT",
        ),
      ).toHaveLength(1);
    });
    expect(harness.paramsOf("providers.startLogin")).toHaveLength(1);
    expect(harness.paramsOf("providers.awaitLogin")).toHaveLength(1);
  });
});
