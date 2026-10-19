/**
 * Where Home's "Created by" rules meet (Tracy Bots T21): the group card asks
 * the member directory only for a TEAM environment and only when the band's
 * host answers `environment.members`, and hands each row the label built
 * from the signed-in viewer and that directory.
 *
 * The rows and the directory hook are stubs; the card's own wiring is real.
 */
import { StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import { HomeBotsGroupCard } from "@/components/home/bots/home-bots-group";
import type { HomeBotsGroup } from "@/lib/home-bots/bots-model";
import { useAuthStore } from "@/stores/auth/auth-store";

const mocks = vi.hoisted(() => ({
  supported: true as boolean | null,
  supportQueries: [] as Array<{ hostId: string | null; method: string }>,
  memberQueries: [] as Array<{
    environmentId: string | null;
    enabled: boolean;
  }>,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (hostId: string | null, method: string) => {
    mocks.supportQueries.push({ hostId, method });
    return mocks.supported;
  },
}));
// The directory knows one teammate by name, and answers only when asked.
vi.mock("@/hooks/bots/use-environment-members-query", () => ({
  useEnvironmentMembers: (
    _client: unknown,
    environmentId: string | null,
    enabled: boolean,
  ) => {
    mocks.memberQueries.push({ environmentId, enabled });
    return (userId: string) =>
      enabled && userId === "user-teammate"
        ? { displayName: "Tess Teammate", avatarUrl: null }
        : null;
  },
}));
vi.mock("@/components/home/bots/home-bot-row", () => ({
  HomeBotRow: (props: { bot: BotRecord; createdBy: string | null }) => (
    <div
      data-testid="stub-bot-row"
      data-bot-id={props.bot.botId}
      data-created-by={props.createdBy ?? "none"}
    />
  ),
}));
vi.mock("@/components/home/bots/create-bot-form", () => ({
  CreateBotForm: () => null,
}));

const HOST = "host-band";
const VIEWER = "user-viewer";

function bot(botId: string, createdByUserId: string | null): BotRecord {
  return {
    botId,
    environmentId: "env-1",
    createdByUserId,
    title: botId,
    harness: "claude",
    model: "opus",
    effort: null,
    profile: null,
    trunkChatId: `trunk-${botId}`,
    boundHostId: null,
    hostEpoch: 1,
    createdAt: 1_000,
    archivedAt: null,
  };
}

function group(ownerKind: HomeBotsGroup["ownerKind"]): HomeBotsGroup {
  return {
    environmentId: "env-1",
    label: ownerKind === "organization" ? "acme" : "Personal",
    ownerKind,
    canCreate: false,
    bots: [
      bot("bot-mine", VIEWER),
      bot("bot-teammate", "user-teammate"),
      bot("bot-stranger", "user-stranger"),
    ],
  };
}

function mountCard(ownerKind: HomeBotsGroup["ownerKind"]): void {
  render(
    <StrictMode>
      <HomeBotsGroupCard
        group={group(ownerKind)}
        hostReach={{
          directoryHostIds: new Set(),
          connectableHostIds: new Set(),
          connectableResolved: true,
          personalHostIds: null,
        }}
        environmentHostIds={null}
        connectableHostIds={[]}
        environmentBindings={{
          byHostId: new Map(),
          failedHostIds: [],
          retryFailed: () => undefined,
        }}
        client={null}
        hostId={HOST}
      />
    </StrictMode>,
  );
}

function createdBy(): Record<string, string | null> {
  return Object.fromEntries(
    screen
      .getAllByTestId("stub-bot-row")
      .map((row) => [
        row.getAttribute("data-bot-id") ?? "",
        row.getAttribute("data-created-by"),
      ]),
  );
}

beforeEach(() => {
  mocks.supported = true;
  mocks.supportQueries.length = 0;
  mocks.memberQueries.length = 0;
  useAuthStore.setState({
    profile: { userId: VIEWER, userName: "Viewer", email: "v@example.com" },
  });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ profile: null });
});

describe("<HomeBotsGroupCard /> attribution", () => {
  it("names who made each team bot from the team's directory, asked of the band's host", () => {
    mountCard("organization");

    expect(mocks.supportQueries).toContainEqual({
      hostId: HOST,
      method: "environment.members",
    });
    expect(mocks.memberQueries).toContainEqual({
      environmentId: "env-1",
      enabled: true,
    });
    expect(createdBy()).toEqual({
      "bot-mine": "Created by you",
      "bot-teammate": "Created by Tess Teammate",
      "bot-stranger": "none",
    });
  });

  it("asks no directory and says nothing for a personal environment's bots", () => {
    mountCard("user");

    expect(mocks.memberQueries.every((query) => !query.enabled)).toBe(true);
    expect(
      mocks.memberQueries.every((query) => query.environmentId === null),
    ).toBe(true);
    expect(createdBy()).toEqual({
      "bot-mine": "none",
      "bot-teammate": "none",
      "bot-stranger": "none",
    });
  });

  it("keeps the viewer's own line but names no teammate on a host without environment.members", () => {
    mocks.supported = false;
    mountCard("organization");

    expect(mocks.memberQueries.every((query) => !query.enabled)).toBe(true);
    expect(createdBy()).toEqual({
      "bot-mine": "Created by you",
      "bot-teammate": "none",
      "bot-stranger": "none",
    });
  });
});
