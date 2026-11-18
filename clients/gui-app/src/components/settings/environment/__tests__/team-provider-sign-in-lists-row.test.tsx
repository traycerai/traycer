import "./team-provider-profiles-test-support";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamProviders } from "@/components/settings/environment/team-providers";
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
  teamProfileRecordsBody,
} from "./team-configuration-test-support";
import { negotiateMethods, reachableHost } from "./mcp-skills-test-support";
import {
  claudeLoginProviderRow,
  handlers,
} from "./team-providers-test-support";

const POLL_MS = 5_000;
const RETIRED_WAITING_SENTENCE =
  "Waiting for Traycer. Your sign-in is complete.";

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

describe("a team sign-in that closes before its row is listed", () => {
  it("lists the row on the configuration revision's own poll, with no focus, and applies the picked colour", async () => {
    teamProfileRecordHttpBoundary.list = {
      status: 200,
      body: teamProfileRecordsBody([]),
    };
    let revision = "10";
    let awaits = 0;
    const harness = mountTeamPageThroughBoundary(
      "admin",
      {
        ...handlers(() => []),
        "environment.host.list": () => ({ hosts: [reachableHost] }),
        "environment.configuration.revision": () => ({ revision }),
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
            : teamAwaitLoginOutcomeAnswer({
                kind: "signed-in",
                profileId: "team-completed-profile",
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
    await userEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Add a profile" }),
      ).getByRole("button", { name: "Sign in" }),
    );

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.queryByText(RETIRED_WAITING_SENTENCE)).toBeNull();
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    expect(
      await screen.findByRole("button", {
        name: "Claude Code profile: Team account ready",
      }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(colourWrites()).toHaveLength(1);
    });
    expect(JSON.stringify(colourWrites()[0]?.body)).not.toContain(
      '"color":null',
    );
    expect(harness.paramsOf("providers.startLogin")).toHaveLength(1);
    expect(harness.paramsOf("providers.awaitLogin")).toHaveLength(2);
  });
});
