import "./team-provider-profiles-test-support";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_PROFILE_ACCENT_COLORS } from "@traycer/protocol/host/provider-schemas";
import { TeamProviders } from "@/components/settings/environment/team-providers";
import { AMBIENT_AUTH_PENDING_REPOLL_CAP } from "@/lib/providers/provider-ambient-auth";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  admitCurrentUserToTeamWindow,
  configurationItem,
  mountTeamPageThroughBoundary,
  teamAwaitLoginOutcomeAnswer,
  teamAwaitLoginSignInRequestAnswer,
  teamLoginStartedAnswer,
  teamProfileRecord,
  teamProfileRecordHttpBoundary,
  teamProfileRecordReadCount,
  teamProfileRecordsBody,
  type TeamAwaitLoginWireAnswer,
  type TeamBoundaryPageHarness,
  type TeamProfileRecordWireRow,
} from "./team-configuration-test-support";
import { negotiateMethods, reachableHost } from "./mcp-skills-test-support";
import {
  claudeLoginProviderRow,
  handlers,
} from "./team-providers-test-support";

const POLL_MS = 5_000;
const REASK_MS = 2_000;
const PICKED_COLOR = PROVIDER_PROFILE_ACCENT_COLORS[2];

const EXISTING = teamProfileRecord({
  profileId: "team-login-profile",
  harnessId: "claude",
  name: "Team login profile",
  readerLabel: "live",
  kind: "oauth_code",
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function colourWrites() {
  return teamProfileRecordHttpBoundary.calls.filter(
    (call) =>
      call.url.endsWith("/api/v3/environments/env-a/items/managed_profile") &&
      call.method === "PUT",
  );
}

/** The team Providers page, with the sign-in's second answer chosen by the test. */
async function mountTeamProviders(options: {
  readonly records: readonly TeamProfileRecordWireRow[];
  readonly revision: () => string;
  readonly answerAfterRequest: () => TeamAwaitLoginWireAnswer;
}): Promise<TeamBoundaryPageHarness> {
  teamProfileRecordHttpBoundary.list = {
    status: 200,
    body: teamProfileRecordsBody([...options.records]),
  };
  let awaits = 0;
  const harness = mountTeamPageThroughBoundary(
    "admin",
    {
      ...handlers(() => []),
      "environment.host.list": () => ({ hosts: [reachableHost] }),
      "environment.configuration.revision": () => ({
        revision: options.revision(),
      }),
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
          : options.answerAfterRequest();
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
  return harness;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("a team sign-in that closes before its row is listed", () => {
  it("lists the row on the configuration revision's own poll, with no focus, and writes the picked colour", async () => {
    let revision = "10";
    const harness = await mountTeamProviders({
      records: [],
      revision: () => revision,
      answerAfterRequest: () =>
        teamAwaitLoginOutcomeAnswer({
          kind: "signed-in",
          profileId: "team-completed-profile",
        }),
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Add a profile" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Add a profile" });
    await userEvent.click(
      within(dialog).getByRole("button", { name: `Use color ${PICKED_COLOR}` }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in" }),
    );

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(harness.paramsOf("providers.cancelLogin")).toEqual([]);
    expect(colourWrites()).toEqual([]);

    // The record lands in the cloud and moves the environment's revision.
    teamProfileRecordHttpBoundary.items = {
      status: 200,
      body: {
        items: [
          configurationItem({
            kind: "managed_profile",
            key: "claude:team-completed-profile",
            value: {
              name: "Team account ready",
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
    revision = "11";
    await advance(POLL_MS);

    expect(
      await screen.findByRole("button", {
        name: "Claude Code profile: Team account ready",
      }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(colourWrites()).toHaveLength(1);
    });
    const written = colourWrites()[0]?.body;
    expect(typeof written === "string" ? written : null).toContain(
      `"color":"${PICKED_COLOR}"`,
    );
    expect(harness.paramsOf("providers.startLogin")).toHaveLength(1);
    expect(harness.paramsOf("providers.awaitLogin")).toHaveLength(2);
  });

  it.each(["Add a profile", "Sign in again"] as const)(
    "settles %s as a completed sign-in once the host keeps answering with no profile past the re-ask cap",
    async (entry) => {
      const harness = await mountTeamProviders({
        records: entry === "Sign in again" ? [EXISTING] : [],
        revision: () => "10",
        answerAfterRequest: () =>
          teamAwaitLoginOutcomeAnswer({ kind: "waiting-for-profile" }),
      });
      await userEvent.click(await screen.findByRole("button", { name: entry }));
      const dialog = await screen.findByRole("dialog", { name: entry });
      if (entry === "Add a profile")
        await userEvent.click(
          within(dialog).getByRole("button", { name: "Sign in" }),
        );

      await advance(REASK_MS * (AMBIENT_AUTH_PENDING_REPOLL_CAP + 1));

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(harness.paramsOf("providers.awaitLogin")).toHaveLength(
        AMBIENT_AUTH_PENDING_REPOLL_CAP + 2,
      );
      expect(harness.paramsOf("providers.cancelLogin")).toEqual([]);
    },
  );
});

describe("a team Switch account whose new row is not listed yet", () => {
  it("keeps the dialog open and reads the team records again, because its move needs the row", async () => {
    const harness = await mountTeamProviders({
      records: [EXISTING],
      revision: () => "10",
      answerAfterRequest: () =>
        teamAwaitLoginOutcomeAnswer({
          kind: "signed-in",
          profileId: "team-switched-profile",
        }),
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Manage" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Switch account" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Add a profile" });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in" }),
    );
    await waitFor(() => {
      expect(harness.paramsOf("providers.awaitLogin")).toHaveLength(2);
    });
    const readsBefore = teamProfileRecordReadCount();

    await advance(REASK_MS * 2);

    expect(teamProfileRecordReadCount()).toBeGreaterThan(readsBefore);
    expect(screen.getByRole("dialog", { name: "Add a profile" })).toBeTruthy();
    expect(harness.paramsOf("providers.cancelLogin")).toEqual([]);
  });
});
