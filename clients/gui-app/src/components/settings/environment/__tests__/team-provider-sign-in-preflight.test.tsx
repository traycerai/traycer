import "./team-provider-profiles-test-support";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  deferTeamProfileRecordAnswer,
  mountTeamPageThroughBoundary,
  teamProfileRecord,
  teamProfileRecordsBody,
  teamProfileRecordHttpBoundary,
  teamProfileRecordReadCount,
  teamAwaitLoginOutcomeAnswer,
  teamLoginStartedAnswer,
} from "./team-configuration-test-support";
import { renderAdmittedTeamPage } from "./team-provider-boundary-render-support";
import { negotiateMethods, reachableHost } from "./mcp-skills-test-support";
import {
  handlers,
  claudeLoginProviderRow,
} from "./team-providers-test-support";

describe("Team Providers sign-in preflight", () => {
  it.each(["add", "reauth"] as const)(
    "holds the team $flow until the real pre-start read answers, then starts once",
    async (flow) => {
      const records =
        flow === "reauth"
          ? [
              {
                ...teamProfileRecord({
                  profileId: "team-login-profile",
                  harnessId: "claude",
                  name: "Team login profile",
                  readerLabel: "live",
                  kind: "oauth_code",
                }),
                enabled: false,
              },
            ]
          : [];
      teamProfileRecordHttpBoundary.list = {
        status: 200,
        body: teamProfileRecordsBody(records),
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
            teamAwaitLoginOutcomeAnswer({ kind: "waiting-for-profile" }),
        },
        "providers",
      );
      negotiateMethods({
        "providers.startLogin": { major: 1, minor: 5 },
        "providers.awaitLogin": { major: 2, minor: 5 },
      });
      await renderAdmittedTeamPage(harness);

      const entryName = flow === "add" ? "Add a profile" : "Sign in again";
      const entry = await screen.findByRole("button", { name: entryName });
      const held = deferTeamProfileRecordAnswer();
      teamProfileRecordHttpBoundary.nextListAnswer = held;
      await userEvent.click(entry);
      const dialog = await screen.findByRole("dialog", { name: entryName });
      await waitFor(() => {
        expect(teamProfileRecordReadCount()).toBe(2);
      });
      expect(harness.paramsOf("providers.startLogin")).toEqual([]);
      if (flow === "add")
        expect(
          within(dialog).queryByRole("button", { name: "Sign in" }),
        ).toBeNull();

      held.resolve({
        status: 200,
        body: teamProfileRecordsBody(records),
      });
      if (flow === "add")
        await userEvent.click(
          await screen.findByRole("button", { name: "Sign in" }),
        );
      await waitFor(() => {
        expect(harness.paramsOf("providers.startLogin")).toHaveLength(1);
      });
      expect(harness.paramsOf("providers.awaitLogin")).toHaveLength(1);
      expect(harness.paramsOf("providers.cancelLogin")).toEqual([]);
    },
  );

  it("uses the latest team role after the held pre-start read and refuses without starting", async () => {
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
      },
      "providers",
    );
    negotiateMethods({
      "providers.startLogin": { major: 1, minor: 5 },
      "providers.awaitLogin": { major: 2, minor: 5 },
    });
    await renderAdmittedTeamPage(harness);

    const entry = await screen.findByRole("button", { name: "Add a profile" });
    const held = deferTeamProfileRecordAnswer();
    teamProfileRecordHttpBoundary.nextListAnswer = held;
    await userEvent.click(entry);
    const dialog = await screen.findByRole("dialog", {
      name: "Add a profile",
    });
    await waitFor(() => {
      expect(teamProfileRecordReadCount()).toBe(2);
    });
    expect(harness.paramsOf("providers.startLogin")).toEqual([]);

    harness.environmentListState.currentRole = "viewer";
    await harness.rereadEnvironmentList();
    expect(
      await within(dialog).findByText(
        "Only admins and editors of Acme can sign in for it.",
      ),
    ).toBeTruthy();
    held.resolve({
      status: 200,
      body: teamProfileRecordsBody([]),
    });
    expect(
      await within(dialog).findByText(
        "Only admins and editors of Acme can sign in for it.",
      ),
    ).toBeTruthy();
    expect(harness.paramsOf("providers.startLogin")).toEqual([]);
  });

  it("uses a team list that changed after render and before Sign in again", async () => {
    const existing = teamProfileRecord({
      profileId: "team-removed-before-reauth",
      harnessId: "claude",
      name: "Team profile before sign-in",
      readerLabel: "live",
      kind: "oauth_code",
    });
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([existing]),
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
      },
      "providers",
    );
    negotiateMethods({
      "providers.startLogin": { major: 1, minor: 5 },
      "providers.awaitLogin": { major: 2, minor: 5 },
    });
    await renderAdmittedTeamPage(harness);

    const entry = await screen.findByRole("button", { name: "Sign in again" });
    expect(teamProfileRecordReadCount()).toBe(1);
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([]),
    };
    await userEvent.click(entry);
    const dialog = await screen.findByRole("dialog", { name: "Sign in again" });

    expect(await within(dialog).findByText("Was removed")).toBeTruthy();
    expect(teamProfileRecordReadCount()).toBe(2);
    expect(harness.paramsOf("providers.startLogin")).toEqual([]);
  });

  it.each([
    {
      label: "team profile sync is off",
      answer: { status: 200, body: { enabled: false } },
    },
    {
      label: "the fresh team list cannot be read",
      answer: { status: 503, body: null },
    },
  ])(
    "shows the existing unavailable refusal after $label and does not start",
    async ({ answer }) => {
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
        },
        "providers",
      );
      negotiateMethods({
        "providers.startLogin": { major: 1, minor: 5 },
        "providers.awaitLogin": { major: 2, minor: 5 },
      });
      await renderAdmittedTeamPage(harness);

      const entry = await screen.findByRole("button", {
        name: "Add a profile",
      });
      const held = deferTeamProfileRecordAnswer();
      teamProfileRecordHttpBoundary.nextListAnswer = held;
      await userEvent.click(entry);
      const dialog = await screen.findByRole("dialog", {
        name: "Add a profile",
      });
      await waitFor(() => {
        expect(teamProfileRecordReadCount()).toBe(2);
      });
      expect(harness.paramsOf("providers.startLogin")).toEqual([]);
      held.resolve(answer);

      expect(
        await within(dialog).findByText(
          "Acme can't take this sign-in right now. Nothing was changed.",
        ),
      ).toBeTruthy();
      expect(harness.paramsOf("providers.startLogin")).toEqual([]);
    },
  );
});
