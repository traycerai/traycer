/**
 * Integrated hover-card coverage for terminal-agent identity.
 *
 * Uses the real Radix HoverCard primitives (via HoverPreviewCard). Only host
 * data / epic-store boundaries are stubbed - not the hover surface itself.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { WorktreeOwnerMetadataTooltip } from "@/components/worktree/worktree-owner-metadata";

interface TuiAgentFixture {
  readonly harnessId: "claude";
  readonly model: string;
  readonly reasoningEffort: string;
  readonly profileId: string | null;
  readonly updatedAt: number;
}

const tuiAgent = vi.hoisted<{ current: TuiAgentFixture }>(() => ({
  current: {
    harnessId: "claude" as const,
    model: "sonnet-4.5",
    reasoningEffort: "high",
    profileId: "profile-1",
    updatedAt: 1_700_000,
  },
}));
const wireProfiles = vi.hoisted(() => ({
  current: [] as ReadonlyArray<ProviderProfile>,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useChatById: () => null,
}));
vi.mock("@/hooks/use-epic-store", () => ({
  useEpicStore: (select: (state: unknown) => unknown) =>
    select({
      tuiAgents: {
        byId: { "owner-1": tuiAgent.current },
      },
    }),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => ({ getActiveHostId: () => "host-1" }),
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalog: () => ({
    harnesses: [
      {
        id: "claude",
        label: "Claude Code",
        models: [
          {
            harnessId: "claude",
            slug: "sonnet-4.5",
            label: "Claude Sonnet 4.5",
            supportedReasoningEfforts: [
              { id: "high", label: "High", description: null },
            ],
            metadata: {},
          },
        ],
      },
    ],
  }),
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({
    data: {
      providers: [
        { providerId: "claude-code", profiles: wireProfiles.current },
      ],
    },
  }),
}));
// Terminal agents keep their settings on the store projection, so this read is
// disabled for every owner in this suite. Mocked rather than provided for: the
// real hook needs a `QueryClientProvider`, and standing one up here would be
// scaffolding for a query that is never issued.
vi.mock("@/hooks/chats/use-chat-run-settings-query", () => ({
  useChatRunSettings: () => ({ data: undefined }),
}));
vi.mock("@/hooks/worktree/use-worktree-owner-metadata-query", () => ({
  useWorktreeOwnerMetadata: () => ({
    binding: null,
    worktrees: [],
    workspaces: [],
    isPending: false,
    error: null,
    checkedAt: null,
    isRefreshing: false,
    refresh: () => Promise.resolve(),
  }),
}));

const OPEN_DELAY_MS = 500;

function profile(
  profileId: string,
  kind: "ambient" | "managed",
  label: string,
): ProviderProfile {
  return {
    profileId,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

const TWO_PROFILES = [
  profile("ambient", "ambient", "Terminal account"),
  profile("profile-1", "managed", "Work account"),
];

function cardIsOpen(): boolean {
  return document.querySelector('[data-slot="hover-card-content"]') !== null;
}

function hoverIn(trigger: HTMLElement): void {
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
}

function settleOpenDelay(): void {
  act(() => {
    vi.advanceTimersByTime(OPEN_DELAY_MS * 2);
  });
}

function openTuiHoverCard(): void {
  render(
    <WorktreeOwnerMetadataTooltip
      trigger={
        <button type="button" data-testid="tui-row">
          Terminal agent row
        </button>
      }
      title="Managed terminal agent"
      hostId="host-1"
      epicId="epic-1"
      ownerId="owner-1"
      ownerKind="terminal-agent"
      supplementalContent={null}
      side="right"
    />,
  );
  const trigger = screen.getByTestId("tui-row");
  hoverIn(trigger);
  settleOpenDelay();
  expect(cardIsOpen()).toBe(true);
}

describe("TUI agent hover card identity (real HoverCard)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    wireProfiles.current = TWO_PROFILES;
    tuiAgent.current = {
      harnessId: "claude",
      model: "sonnet-4.5",
      reasoningEffort: "high",
      profileId: "profile-1",
      updatedAt: 1_700_000,
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows profile-badged harness a11y label, model, and effort for a managed profile", () => {
    openTuiHoverCard();

    // Real Radix content is in the tree (not a mocked hover surface).
    expect(
      document.querySelector('[data-slot="hover-card-content"]'),
    ).not.toBeNull();
    expect(
      screen.getByRole("img", { name: "Claude Code, Work account" }),
    ).toBeTruthy();
    expect(screen.getByTestId("owner-settings-model").textContent).toContain(
      "Claude Sonnet 4.5",
    );
    expect(screen.getByTestId("owner-settings-reasoning").textContent).toBe(
      "High",
    );
    // TUI records have no serviceTier / fast mode field.
    expect(screen.queryByLabelText("Fast mode")).toBeNull();
    expect(screen.queryByText("Fast")).toBeNull();
  });

  it("keeps ambient TUI hover identity unbadged", () => {
    tuiAgent.current = {
      ...tuiAgent.current,
      profileId: null,
    };
    openTuiHoverCard();

    expect(screen.getByRole("img", { name: "Claude Code" })).toBeTruthy();
    const mark = screen.getByTestId("owner-settings-harness-mark");
    expect(mark.querySelector('span[style*="background-color"]')).toBeNull();
  });

  it("degrades tombstoned TUI profile to bare harness without error chrome", () => {
    tuiAgent.current = {
      ...tuiAgent.current,
      profileId: "gone-profile",
    };
    openTuiHoverCard();

    expect(screen.getByRole("img", { name: "Claude Code" })).toBeTruthy();
    const mark = screen.getByTestId("owner-settings-harness-mark");
    expect(mark.querySelector('span[style*="background-color"]')).toBeNull();
    expect(screen.queryByText(/error|missing|unknown/i)).toBeNull();
  });
});
