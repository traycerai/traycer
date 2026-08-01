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
    // `claude-code` is the WIRE id for the `claude` harness; the header has to
    // map across that boundary to find these at all.
    data: {
      providers: [
        { providerId: "claude-code", profiles: wireProfiles.current },
      ],
    },
  }),
}));

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

/**
 * The `AccentDot` itself, found by its inline accent color - the wrapper's
 * `textContent` is unusable here because the harness brand SVG carries its own
 * `<title>`.
 */
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
    // jsdom does no layout, so this asserts the CONTRACT rather than a measured
    // width: the row must not wrap, and the model must be the segment that
    // gives way when the card hits its ceiling. Re-adding `flex-wrap` here is
    // exactly the regression - it silently restores the two-line header the
    // widening behaviour replaced.
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
    // The specific inversion reported: the LEAST restricted mode was the one
    // drawn as locked shut.
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
