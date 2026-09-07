import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorktreeOwnerSettingsHeader } from "@/components/worktree/worktree-owner-settings-header";
import type { PermissionMode } from "@/components/home/data/landing-options";

const chatSettings = vi.hoisted(() => ({
  current: null as ChatRunSettings | null,
}));
const tuiAgent = vi.hoisted(() => ({
  current: null as {
    readonly harnessId: "claude";
    readonly model: string | null;
    readonly reasoningEffort: string | null;
    readonly profileId: string | null;
    readonly updatedAt: number;
  } | null,
}));
const wireProfiles = vi.hoisted(() => ({
  current: [] as ReadonlyArray<ProviderProfile>,
}));
/** What the host answers `epic.getChatRunSettings` with, and whether it was asked at all - the second half
 * matters as much as the first, because the read must stay off for the owners that still have local settings. */
const fetchedSettings = vi.hoisted(() => ({
  current: null as ChatRunSettings | null,
  /** A settled `{ settings: null }` is the host stating the chat has no persisted tuple, which outranks a stale
   * local one. */
  answered: false,
  lastEnabled: null as boolean | null,
}));
/** Per-host-id sentinel clients, plus a switch for "the owner's host cannot
 *  be resolved" (missing from the directory / signed out). */
const hostResolution = vi.hoisted(() => ({
  resolveToNull: false,
  byHostId: new Map<string, { readonly getActiveHostId: () => string }>(),
}));
/** The clients each host-scoped read actually received, so tests assert which host served the catalog and the
 * provider list - not just what data came back (data the mocks themselves supplied). */
const scopedReads = vi.hoisted(() => ({
  catalogClients: [] as unknown[],
  providersClients: [] as unknown[],
  warmupCalls: [] as Array<{
    readonly client: unknown;
    readonly harnessId: string | null;
    readonly enabled: boolean;
  }>,
}));
/** Availability of the fixture's one harness, so tests can drive the subject
 *  warmup's availability gate (a tombstoned/disabled subject must not fetch). */
const catalogAvailability = vi.hoisted(() => ({ subjectAvailable: true }));

vi.mock("@/lib/epic-selectors", () => ({
  useChatById: () =>
    chatSettings.current === null
      ? null
      : { settings: chatSettings.current, updatedAt: 1_700_000 },
}));
vi.mock("@/hooks/use-epic-store", () => ({
  useEpicStore: (select: (state: unknown) => unknown) =>
    select({
      tuiAgents: {
        byId: tuiAgent.current === null ? {} : { "owner-1": tuiAgent.current },
      },
    }),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null || hostResolution.resolveToNull) return null;
    const existing = hostResolution.byHostId.get(hostId);
    if (existing !== undefined) return existing;
    // One stable sentinel per host id, like the real hook's memoized requester.
    const sentinel = { getActiveHostId: () => hostId };
    hostResolution.byHostId.set(hostId, sentinel);
    return sentinel;
  },
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  // Client-scoped like the real hook: a `null` client is a disabled read and yields an empty catalog (never
  // another host's entries), which is what drives the raw-slug fallback the unresolvable-host test asserts.
  useGuiHarnessCatalogForClient: (client: unknown) => {
    scopedReads.catalogClients.push(client);
    return {
      harnesses: client === null ? [] : catalogHarnesses(),
      harnessesLoading: false,
      harnessesError: null,
      modelsLoading: false,
    };
  },
  // Recorded so tests can assert it targets the owner's host and the subject harness - never a fan-out and never
  // another host's client.
  useGuiHarnessModelsWarmup: (
    client: unknown,
    harnessId: string | null,
    activity: { readonly enabled: boolean; readonly subscribed: boolean },
  ) => {
    scopedReads.warmupCalls.push({
      client,
      harnessId,
      enabled: activity.enabled,
    });
  },
}));
const catalogHarnesses = vi.hoisted(() => () => [
  {
    id: "claude",
    label: "Claude Code",
    // The subject warmup gates on this flag (an availability-blind warmup
    // would hit a disabled provider's listModels on every card open).
    available: catalogAvailability.subjectAvailable,
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
      // A second model, so a host tuple and a local tuple can disagree visibly - which is the only way to test which
      // one the header trusts.
      {
        harnessId: "claude",
        slug: "opus-4.1",
        label: "Claude Opus 4.1",
        supportedReasoningEfforts: [
          { id: "high", label: "High", description: null },
        ],
        metadata: {},
      },
    ],
  },
]);
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: (client: unknown) => {
    scopedReads.providersClients.push(client);
    // `claude-code` is the wire id for the `claude` harness; the header has to map across that boundary to find
    // these at all.
    return {
      data:
        client === null
          ? undefined
          : {
              providers: [
                { providerId: "claude-code", profiles: wireProfiles.current },
              ],
            },
    };
  },
}));
// Records `enabled` rather than ignoring it: a mock that always answers would let the header read a fetched
// tuple it never actually requested, and the "store settings win.
vi.mock("@/hooks/chats/use-chat-run-settings-query", () => ({
  useChatRunSettings: (args: { readonly enabled: boolean }) => {
    fetchedSettings.lastEnabled = args.enabled;
    const settled = args.enabled && fetchedSettings.answered;
    return {
      data: settled ? { settings: fetchedSettings.current } : undefined,
      isSuccess: settled,
    };
  },
}));

function profile(
  profileId: string,
  kind: "ambient" | "managed",
  label: string,
): ProviderProfile {
  return {
    profileId,
    enabled: true,
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

function renderChatHeader(args: {
  readonly permissionMode: PermissionMode;
  readonly profileId: string | null;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly serviceTier: string | null;
}): void {
  chatSettings.current = {
    harnessId: "claude",
    model: "sonnet-4.5",
    permissionMode: args.permissionMode,
    reasoningEffort: "high",
    serviceTier: args.serviceTier,
    agentMode: "regular",
    profileId: args.profileId,
  };
  tuiAgent.current = null;
  wireProfiles.current = args.profiles;
  render(
    <WorktreeOwnerSettingsHeader
      ownerId="owner-1"
      hostId="host-1"
      epicId="epic-1"
      ownerKind="chat"
    />,
  );
}

function renderTuiHeader(args: {
  readonly profileId: string | null;
  readonly profiles: ReadonlyArray<ProviderProfile>;
}): void {
  chatSettings.current = null;
  tuiAgent.current = {
    harnessId: "claude",
    model: "sonnet-4.5",
    reasoningEffort: "high",
    profileId: args.profileId,
    updatedAt: 1_700_000,
  };
  wireProfiles.current = args.profiles;
  render(
    <WorktreeOwnerSettingsHeader
      ownerId="owner-1"
      hostId="host-1"
      epicId="epic-1"
      ownerKind="terminal-agent"
    />,
  );
}

/** Identifies which lucide glyph rendered, without pinning its exact name. */
function permissionIconClass(): string {
  const svg = document.querySelector(
    '[data-testid="owner-settings-permissions"] svg',
  );
  return svg?.getAttribute("class") ?? "";
}

/** The `AccentDot` itself, found by its inline accent color - the wrapper's `textContent` is unusable here
 * because the harness brand SVG carries its own `<title>`. */
function accentDotText(): string | null {
  const mark = screen.getByTestId("owner-settings-harness-mark");
  const dot = mark.querySelector('span[style*="background-color"]');
  return dot === null ? null : dot.textContent;
}

const TWO_PROFILES = [
  profile("ambient", "ambient", "Terminal account"),
  profile("profile-1", "managed", "Work account"),
];

describe("WorktreeOwnerSettingsHeader", () => {
  afterEach(() => {
    cleanup();
    chatSettings.current = null;
    tuiAgent.current = null;
    wireProfiles.current = [];
    fetchedSettings.current = null;
    fetchedSettings.answered = false;
    fetchedSettings.lastEnabled = null;
    hostResolution.resolveToNull = false;
    hostResolution.byHostId.clear();
    scopedReads.catalogClients = [];
    scopedReads.providersClients = [];
    scopedReads.warmupCalls = [];
    catalogAvailability.subjectAvailable = true;
  });

  it("warms exactly the subject harness's models on the owner's host - the card's only permitted model fetch", () => {
    // The catalog read is `"cached-only"` (an all-harness `listModels` fan-out here would spawn every provider
    // server on the owner's host to label one tuple).
    renderChatHeader({
      permissionMode: "full_access",
      profileId: null,
      profiles: [],
      serviceTier: null,
    });

    const ownerClient = hostResolution.byHostId.get("host-1");
    expect(ownerClient).toBeDefined();
    expect(scopedReads.warmupCalls.length).toBeGreaterThan(0);
    for (const call of scopedReads.warmupCalls) {
      expect(call.client).toBe(ownerClient);
      expect(call.harnessId).toBe("claude");
      expect(call.enabled).toBe(true);
    }
  });

  it("keeps the warmup disabled while the subject harness is unavailable - a tombstoned subject must not hit its provider's listModels", () => {
    // `hasSubject` is still true (the card renders, with the raw-slug fallback), so availability is the only thing
    // standing between every card open and a doomed listModels attempt.
    catalogAvailability.subjectAvailable = false;
    renderChatHeader({
      permissionMode: "full_access",
      profileId: null,
      profiles: [],
      serviceTier: null,
    });

    expect(scopedReads.warmupCalls.length).toBeGreaterThan(0);
    for (const call of scopedReads.warmupCalls) {
      expect(call.enabled).toBe(false);
    }
  });

  it("reads the harness catalog through the OWNER's host client - the same one the provider list uses", () => {
    // The regression this guards: the catalog read went through the app-wide default host
    // (`useGuiHarnessCatalog(null, …)`) while the provider list beside it was scoped to `props.hostId`.
    renderChatHeader({
      permissionMode: "full_access",
      profileId: null,
      profiles: [],
      serviceTier: null,
    });

    const ownerClient = hostResolution.byHostId.get("host-1");
    expect(ownerClient).toBeDefined();
    expect(scopedReads.catalogClients.length).toBeGreaterThan(0);
    // Every catalog read AND every provider-list read received the owner's
    // pinned client - one shared host resolution, no default-host leak.
    for (const client of scopedReads.catalogClients) {
      expect(client).toBe(ownerClient);
    }
    for (const client of scopedReads.providersClients) {
      expect(client).toBe(ownerClient);
    }
    // And that catalog actually carried the labels: proof the header's label
    // source is the client-scoped read, not some other path.
    expect(screen.getByTestId("owner-settings-model").textContent).toContain(
      "Claude Sonnet 4.5",
    );
  });

  it("falls back to raw slugs when the owner's host cannot be resolved, instead of borrowing another host's catalog", () => {
    hostResolution.resolveToNull = true;
    renderChatHeader({
      permissionMode: "full_access",
      profileId: null,
      profiles: [],
      serviceTier: null,
    });

    // The read still happened - with a null client (disabled), never a
    // fallback to a different host's client.
    expect(scopedReads.catalogClients.length).toBeGreaterThan(0);
    for (const client of scopedReads.catalogClients) {
      expect(client).toBeNull();
    }
    // Raw persisted slug, not the default host's friendly label.
    const model = screen.getByTestId("owner-settings-model").textContent;
    expect(model).toContain("sonnet-4.5");
    expect(model).not.toContain("Claude Sonnet 4.5");
  });

  it("renders a distinct icon for each permission mode", () => {
    // The regression this guards: the row hardcoded ONE padlock for all three
    // modes. Any future hardcoding collapses these three classes into one.
    const seen = new Set<string>();
    for (const mode of [
      "supervised",
      "auto_accept_edits",
      "full_access",
    ] as const) {
      renderChatHeader({
        permissionMode: mode,
        profileId: null,
        profiles: [],
        serviceTier: null,
      });
      seen.add(permissionIconClass());
      cleanup();
    }

    expect(seen.size).toBe(3);
  });

  it("keeps the settings line unwrapped so the card widens instead", () => {
    // jsdom does no layout, so this asserts the contract rather than a measured width: the row must not wrap, and
    // the model must be the segment that gives way when the card hits its ceiling.
    renderChatHeader({
      permissionMode: "full_access",
      profileId: null,
      profiles: [],
      serviceTier: null,
    });

    const row = screen.getByTestId("owner-settings-header").className;
    expect(row).toContain("flex-nowrap");
    expect(row).not.toContain("flex-wrap");
    expect(screen.getByTestId("owner-settings-model").className).toContain(
      "truncate",
    );
    // Short, bounded values hold their ground rather than competing with it.
    expect(
      screen.getByTestId("owner-settings-permissions").className,
    ).toContain("shrink-0");
  });

  it("does not render Full access behind a padlock", () => {
    // The specific inversion reported: the least restricted mode was the one drawn as locked shut.
    renderChatHeader({
      permissionMode: "full_access",
      profileId: null,
      profiles: [],
      serviceTier: null,
    });

    expect(screen.getByText("Full access")).toBeTruthy();
    expect(permissionIconClass().split(/\s+/)).not.toContain("lucide-lock");
    expect(permissionIconClass()).toMatch(/open|unlock/);
  });

  it("shows the profile as a corner dot, not as trailing text", () => {
    renderChatHeader({
      permissionMode: "full_access",
      profileId: "profile-1",
      profiles: TWO_PROFILES,
      serviceTier: null,
    });

    // The name is gone from the line - that is the whole point, it was what
    // wrapped the row in two.
    expect(screen.queryByText("Work account")).toBeNull();
    // ...but it is still announced, since `AccentDot` itself is aria-hidden.
    expect(
      screen.getByRole("img", { name: "Claude Code, Work account" }),
    ).toBeTruthy();
    expect(accentDotText()).toBe("W");
  });

  it("badges the ambient profile the chat actually runs on", () => {
    renderChatHeader({
      permissionMode: "full_access",
      profileId: null,
      profiles: TWO_PROFILES,
      serviceTier: null,
    });

    expect(
      screen.getByRole("img", { name: "Claude Code, Terminal account" }),
    ).toBeTruthy();
  });

  it("omits the dot when the provider has a single profile", () => {
    renderChatHeader({
      permissionMode: "full_access",
      profileId: "profile-1",
      profiles: [profile("profile-1", "managed", "Work account")],
      serviceTier: null,
    });

    expect(screen.getByRole("img", { name: "Claude Code" })).toBeTruthy();
    expect(accentDotText()).toBeNull();
  });

  it("renders fast mode as an amber Zap with Fast mode a11y label, not the word Fast", () => {
    renderChatHeader({
      permissionMode: "full_access",
      profileId: null,
      profiles: [],
      serviceTier: "fast",
    });

    const zap = screen.getByLabelText("Fast mode");
    expect(zap.getAttribute("class") ?? "").toMatch(/lucide-zap/);
    expect(zap.getAttribute("class") ?? "").toContain("text-amber-500");
    expect(screen.queryByText("Fast")).toBeNull();
    expect(screen.queryByTestId("owner-settings-fast-mode")).toBeNull();
  });

  it("renders no fast icon when serviceTier is off", () => {
    renderChatHeader({
      permissionMode: "full_access",
      profileId: null,
      profiles: [],
      serviceTier: null,
    });

    expect(screen.queryByLabelText("Fast mode")).toBeNull();
    expect(screen.queryByText("Fast")).toBeNull();
  });

  it("shows managed TUI profile badge, model, and effort", () => {
    renderTuiHeader({
      profileId: "profile-1",
      profiles: TWO_PROFILES,
    });

    expect(
      screen.getByRole("img", { name: "Claude Code, Work account" }),
    ).toBeTruthy();
    expect(accentDotText()).toBe("W");
    expect(screen.getByTestId("owner-settings-model").textContent).toContain(
      "Claude Sonnet 4.5",
    );
    expect(screen.getByTestId("owner-settings-reasoning").textContent).toBe(
      "High",
    );
    expect(screen.queryByTestId("owner-settings-permissions")).toBeNull();
    expect(screen.queryByLabelText("Fast mode")).toBeNull();
  });

  it("keeps ambient TUI harness bare (no profile badge)", () => {
    renderTuiHeader({
      profileId: null,
      profiles: TWO_PROFILES,
    });

    expect(screen.getByRole("img", { name: "Claude Code" })).toBeTruthy();
    expect(accentDotText()).toBeNull();
  });

  it("degrades a tombstoned TUI profile to bare harness without error text", () => {
    renderTuiHeader({
      profileId: "missing-profile",
      profiles: TWO_PROFILES,
    });

    expect(screen.getByRole("img", { name: "Claude Code" })).toBeTruthy();
    expect(accentDotText()).toBeNull();
    expect(screen.queryByText(/error|missing|unknown/i)).toBeNull();
    expect(screen.getByTestId("owner-settings-model").textContent).toContain(
      "Claude Sonnet 4.5",
    );
  });
});

/** The single-write regression: a chat that exists only as a host registry row has `settings: null` on its
 * projection (`chatProjectionFromRecord`), because the row carries a harness-id summary and not the tuple. */
describe("chat settings sourced from the host", () => {
  afterEach(() => {
    cleanup();
    chatSettings.current = null;
    tuiAgent.current = null;
    wireProfiles.current = [];
    fetchedSettings.current = null;
    fetchedSettings.answered = false;
    fetchedSettings.lastEnabled = null;
    hostResolution.resolveToNull = false;
    hostResolution.byHostId.clear();
    scopedReads.catalogClients = [];
    scopedReads.providersClients = [];
    scopedReads.warmupCalls = [];
    catalogAvailability.subjectAvailable = true;
  });

  function renderRegistryOnlyChat(): void {
    // A registry-only chat: the projection exists (so the row renders and has
    // an `updatedAt`) but carries no settings tuple.
    chatSettings.current = null;
    tuiAgent.current = null;
    wireProfiles.current = [];
    render(
      <WorktreeOwnerSettingsHeader
        ownerId="owner-1"
        hostId="host-1"
        epicId="epic-1"
        ownerKind="chat"
      />,
    );
  }

  it("renders the full settings line from the fetched tuple", () => {
    fetchedSettings.answered = true;
    fetchedSettings.current = {
      harnessId: "claude",
      model: "sonnet-4.5",
      permissionMode: "full_access",
      reasoningEffort: "high",
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    };

    renderRegistryOnlyChat();

    expect(fetchedSettings.lastEnabled).toBe(true);
    expect(screen.getByTestId("owner-settings-model").textContent).toContain(
      "Claude Sonnet 4.5",
    );
    expect(screen.getByTestId("owner-settings-reasoning").textContent).toBe(
      "High",
    );
    expect(
      screen.getByTestId("owner-settings-permissions").textContent,
    ).toContain("Full access");
  });

  it("renders nothing when the host answers no tuple", () => {
    // With no local tuple either, that must read as an absent header, never as a half-populated line.
    fetchedSettings.answered = true;
    fetchedSettings.current = null;

    renderRegistryOnlyChat();

    expect(fetchedSettings.lastEnabled).toBe(true);
    expect(screen.queryByTestId("owner-settings-header")).toBeNull();
  });

  it("prefers the host tuple over a local one that disagrees", () => {
    // Gating the read on its absence, or letting it win the coalesce, would pin the card to values that stopped
    // being true at the user's first model change.
    fetchedSettings.answered = true;
    fetchedSettings.current = {
      harnessId: "claude",
      model: "opus-4.1",
      permissionMode: "full_access",
      reasoningEffort: "high",
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    };

    renderChatHeader({
      permissionMode: "full_access",
      profileId: null,
      profiles: [],
      serviceTier: null,
    });

    expect(fetchedSettings.lastEnabled).toBe(true);
    expect(screen.getByTestId("owner-settings-model").textContent).toContain(
      "Claude Opus 4.1",
    );
  });

  it("falls back to the local tuple while the host read has not answered", () => {
    // In flight, errored, unsupported, or an unreachable owner host whose query never runs - none of them should
    // blank a row that already had something true enough to show.
    fetchedSettings.answered = false;
    fetchedSettings.current = null;

    renderChatHeader({
      permissionMode: "full_access",
      profileId: null,
      profiles: [],
      serviceTier: null,
    });

    expect(screen.getByTestId("owner-settings-model").textContent).toContain(
      "Claude Sonnet 4.5",
    );
  });

  it("honors a settled null over a frozen local tuple", () => {
    // The other side of the fallback, and the one that is easy to get wrong: a successful `{ settings: null }` is
    // the host saying this chat has no persisted tuple, not the absence of an answer.
    fetchedSettings.answered = true;
    fetchedSettings.current = null;

    renderChatHeader({
      permissionMode: "full_access",
      profileId: null,
      profiles: [],
      serviceTier: null,
    });

    expect(fetchedSettings.lastEnabled).toBe(true);
    expect(screen.queryByTestId("owner-settings-header")).toBeNull();
  });

  it("does not ask the host for a terminal agent", () => {
    renderTuiHeader({ profileId: null, profiles: [] });

    expect(fetchedSettings.lastEnabled).toBe(false);
  });
});
