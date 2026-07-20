import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "zustand";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
  ProviderProfileRateLimitStatus,
} from "@traycer/protocol/host/provider-schemas";
import type { ModelOption } from "@/components/home/data/landing-options";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfileRateLimitSwitchBanner } from "@/components/chat/composer/profile-rate-limit-switch-banner";
import { useProfileRateLimitSwitchPrompt } from "@/components/chat/composer/use-profile-rate-limit-switch-prompt";
import { buildChatRunSettings } from "@/lib/composer/chat-run-settings";
import {
  createComposerToolbarStore,
  type ComposerToolbarStore,
} from "@/stores/composer/composer-toolbar-store";
import { commitProfileSelection } from "@/stores/composer/commit-selection";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useRateLimitSwitchPromptDismissalsStore } from "@/stores/rate-limits/rate-limit-switch-prompt-dismissals-store";

/**
 * Landing-surface durability for the rate-limit switch banner.
 *
 * Mirrors landing-composer.tsx wiring:
 * - real `useProfileRateLimitSwitchPrompt` (default-host providers list)
 * - real `ProfileRateLimitSwitchBanner`
 * - real landing `ComposerToolbarStore` + `commitProfileSelection`
 * - real shared dismissal store
 * - `affectedChatCount: 0`, `runTargetHostId: null`
 * - submit-time settings via `buildChatRunSettings` (same builder the landing
 *   actions path uses for `epic.create`)
 *
 * Fakes only the host providers-list transport and usage presentation
 * (external boundary / nondeterministic gauges). Does not mock the prompt
 * seam under test (closes T2 review P3-1).
 */

const mocks = vi.hoisted(() => ({
  /** `undefined` = still loading; array = settled providers.list payload. */
  providers: undefined as ProviderCliState[] | undefined,
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: (
    _client: unknown,
    activity: { enabled: boolean },
  ) => {
    if (!activity.enabled) return { data: undefined };
    if (mocks.providers === undefined) return { data: undefined };
    return { data: { providers: mocks.providers } };
  },
}));

vi.mock("@/hooks/rate-limits/use-profile-usage-presentation", () => ({
  useProfileUsagePresentation: () => ({
    isHostReady: true,
    entries: new Map(),
  }),
}));

function profile(input: {
  readonly profileId: string;
  readonly kind: "ambient" | "managed";
  readonly label: string;
  readonly rateLimitStatus: ProviderProfileRateLimitStatus;
  readonly rateLimitLimitedScopes: ProviderProfile["rateLimitLimitedScopes"];
  readonly authenticated: boolean;
}): ProviderProfile {
  const {
    profileId,
    kind,
    label,
    rateLimitStatus,
    rateLimitLimitedScopes,
    authenticated,
  } = input;
  return {
    profileId,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: authenticated ? "authenticated" : "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus,
    rateLimitLimitedScopes,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
  };
}

function claudeState(
  profiles: ReadonlyArray<ProviderProfile>,
): ProviderCliState {
  const providerId: ProviderId = "claude-code";
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [...profiles],
  };
}

function model(slug: string, label: string): ModelOption {
  return {
    harnessId: "claude",
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

const OPUS = model("opus[1m]", "Opus");
const FABLE = model("claude-fable-5[1m]", "Fable");
const SONNET = model("claude-sonnet", "Sonnet");

const VERY_LONG_LABEL = "A".repeat(2000);
const RTL_CONTROL_LABEL = "\u202Ework\u202C\u0000\u200B\u200E\u200F-profile";
const HTML_LOOKING_LABEL = '<img src=x onerror="alert(1)">';
const SCRIPT_LOOKING_LABEL = "</span><script>alert(1)</script>";

function createLandingToolbarStore(
  profileId: string | null,
): ComposerToolbarStore {
  return createComposerToolbarStore({
    seedKey: `landing-durability:${profileId ?? "ambient"}`,
    values: {
      permission: "supervised",
      selection: {
        harnessId: "claude",
        modelSlug: SONNET.slug,
        profileId,
      },
      reasoning: "",
      serviceTier: "",
      agentMode: "regular",
    },
    onSettingsChange: null,
    tuiOnly: false,
  });
}

/**
 * Landing-composer-like mount: toolbar store selection drives the real prompt;
 * switch commits through `commitProfileSelection` exactly as landing does.
 */
function LandingRateLimitBannerHarness(props: {
  readonly toolbarStore: ComposerToolbarStore;
  readonly selectedModel: ModelOption | null;
  readonly active: boolean;
}) {
  const harnessId = useStore(
    props.toolbarStore,
    (state) => state.selection.harnessId,
  );
  const profileId = useStore(
    props.toolbarStore,
    (state) => state.selection.profileId,
  );
  const prompt = useProfileRateLimitSwitchPrompt({
    harnessId,
    profileId,
    selectedModel: props.selectedModel,
    active: props.active,
    // Landing passes `useHostClient()`; the list mock is the host boundary.
    client: null,
  });
  const visible = prompt.kind === "visible";
  // Mirror submit-time settings construction in use-landing-composer-actions:
  // read the live toolbar state and run it through buildChatRunSettings so a
  // switch is observable on the epic.create payload shape.
  const toolbarState = props.toolbarStore.getState();
  const submitSettings = buildChatRunSettings({
    selection: {
      ...toolbarState.selection,
      profileId,
    },
    permission: toolbarState.permission,
    reasoning: toolbarState.reasoning,
    serviceTier: toolbarState.serviceTier,
    agentMode: toolbarState.agentMode,
  });

  return (
    <TooltipProvider delayDuration={0}>
      <div>
        <div data-testid="profile-id">{profileId ?? "ambient"}</div>
        <div data-testid="banner-visible">{String(visible)}</div>
        <div data-testid="submit-profile-id">
          {submitSettings.profileId ?? "ambient"}
        </div>
        {visible ? (
          <ProfileRateLimitSwitchBanner
            key={prompt.warningKey}
            harnessId={harnessId}
            providerId={prompt.providerId}
            severity={prompt.severity}
            limitedFamilies={prompt.limitedFamilies}
            current={prompt.current}
            profiles={prompt.profiles}
            destinations={prompt.destinations}
            primaryTarget={prompt.primaryTarget}
            probeTarget={prompt.probeTarget}
            runTargetHostId={null}
            onSwitchProfile={(nextProfileId) => {
              commitProfileSelection(props.toolbarStore, nextProfileId);
            }}
            affectedChatCount={0}
            onSwitchProfileForTask={() => undefined}
            onDismiss={prompt.dismiss}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}

/** Chat-surface twin that shares only the dismissal store (same warningKey). */
function ChatSurfaceDismissHarness(props: {
  readonly profileId: string | null;
  readonly selectedModel: ModelOption | null;
}) {
  const prompt = useProfileRateLimitSwitchPrompt({
    harnessId: "claude",
    profileId: props.profileId,
    selectedModel: props.selectedModel,
    active: true,
    client: null,
  });
  return (
    <TooltipProvider delayDuration={0}>
      <div>
        <div data-testid="chat-banner-visible">
          {String(prompt.kind === "visible")}
        </div>
        {prompt.kind === "visible" ? (
          <ProfileRateLimitSwitchBanner
            key={prompt.warningKey}
            harnessId="claude"
            providerId={prompt.providerId}
            severity={prompt.severity}
            limitedFamilies={prompt.limitedFamilies}
            current={prompt.current}
            profiles={prompt.profiles}
            destinations={prompt.destinations}
            primaryTarget={prompt.primaryTarget}
            probeTarget={prompt.probeTarget}
            runTargetHostId={null}
            onSwitchProfile={() => undefined}
            affectedChatCount={1}
            onSwitchProfileForTask={() => undefined}
            onDismiss={prompt.dismiss}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}

function DualSurfaceHarness(props: {
  readonly toolbarStore: ComposerToolbarStore;
  readonly selectedModel: ModelOption | null;
}) {
  const profileId = useStore(
    props.toolbarStore,
    (state) => state.selection.profileId,
  );
  return (
    <>
      <LandingRateLimitBannerHarness
        toolbarStore={props.toolbarStore}
        selectedModel={props.selectedModel}
        active
      />
      <ChatSurfaceDismissHarness
        profileId={profileId}
        selectedModel={props.selectedModel}
      />
    </>
  );
}

/** Controlled profileId + model for loading/seed transitions without toolbar. */
function LoadingSeedHarness(props: {
  readonly profileId: string | null;
  readonly selectedModel: ModelOption | null;
}) {
  const prompt = useProfileRateLimitSwitchPrompt({
    harnessId: "claude",
    profileId: props.profileId,
    selectedModel: props.selectedModel,
    active: true,
    client: null,
  });
  return (
    <TooltipProvider delayDuration={0}>
      <div>
        <div data-testid="banner-visible">
          {String(prompt.kind === "visible")}
        </div>
        <div data-testid="profile-id">{props.profileId ?? "ambient"}</div>
        {prompt.kind === "visible" ? (
          <ProfileRateLimitSwitchBanner
            key={prompt.warningKey}
            harnessId="claude"
            providerId={prompt.providerId}
            severity={prompt.severity}
            limitedFamilies={prompt.limitedFamilies}
            current={prompt.current}
            profiles={prompt.profiles}
            destinations={prompt.destinations}
            primaryTarget={prompt.primaryTarget}
            probeTarget={prompt.probeTarget}
            runTargetHostId={null}
            onSwitchProfile={() => undefined}
            affectedChatCount={0}
            onSwitchProfileForTask={() => undefined}
            onDismiss={prompt.dismiss}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}

async function macrotaskTick(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

function limitedAmbientAndWork(): ProviderCliState[] {
  return [
    claudeState([
      profile({
        profileId: "ambient",
        kind: "ambient",
        label: "Terminal account",
        rateLimitStatus: "hard_limit",
        rateLimitLimitedScopes: null,
        authenticated: true,
      }),
      profile({
        profileId: "work",
        kind: "managed",
        label: "Work",
        rateLimitStatus: "ok",
        rateLimitLimitedScopes: null,
        authenticated: true,
      }),
    ]),
  ];
}

describe("Landing rate-limit banner durability", () => {
  beforeEach(() => {
    mocks.providers = undefined;
    useRateLimitSwitchPromptDismissalsStore.setState({
      dismissedKeys: new Set<string>(),
    });
    useComposerHarnessMemoryStore.getState().resetForTests();
  });
  afterEach(cleanup);

  describe("1. no banner flash while providers.list loads / seed validates", () => {
    it("never mounts the banner while the default-host providers list is loading, across re-renders", async () => {
      // Seeded limited profileId, but the list has not settled - the shared
      // prompt must stay hidden (profiles.length < 2 / no match) so landing
      // never flashes a warning for an unvalidated seed.
      mocks.providers = undefined;
      const { rerender } = render(
        <LoadingSeedHarness profileId="work" selectedModel={SONNET} />,
      );
      expect(screen.getByTestId("banner-visible").textContent).toBe("false");
      expect(
        screen.queryByRole("region", { name: "Rate-limit profile switch" }),
      ).toBeNull();

      for (let index = 0; index < 5; index += 1) {
        act(() => {
          rerender(
            <LoadingSeedHarness profileId="work" selectedModel={SONNET} />,
          );
        });
        await macrotaskTick();
        expect(screen.getByTestId("banner-visible").textContent).toBe("false");
        expect(
          screen.queryByRole("region", { name: "Rate-limit profile switch" }),
        ).toBeNull();
      }

      // Settle with the seeded managed profile limited + a healthy alternate.
      mocks.providers = [
        claudeState([
          profile({
            profileId: "ambient",
            kind: "ambient",
            label: "Terminal account",
            rateLimitStatus: "ok",
            rateLimitLimitedScopes: null,
            authenticated: true,
          }),
          profile({
            profileId: "work",
            kind: "managed",
            label: "Work",
            rateLimitStatus: "near_limit",
            rateLimitLimitedScopes: null,
            authenticated: true,
          }),
        ]),
      ];
      rerender(<LoadingSeedHarness profileId="work" selectedModel={SONNET} />);
      await macrotaskTick();
      expect(screen.getByTestId("banner-visible").textContent).toBe("true");
      expect(
        screen.getByRole("region", { name: "Rate-limit profile switch" }),
      ).toBeDefined();
    });

    it("stays hidden when a seeded profileId never appears in the settled list (no false flash for a dead pin)", async () => {
      mocks.providers = undefined;
      const { rerender } = render(
        <LoadingSeedHarness
          profileId="stale-managed-id"
          selectedModel={SONNET}
        />,
      );
      expect(screen.getByTestId("banner-visible").textContent).toBe("false");

      // Settled: only ambient + work. The dead seed is not a limited live
      // profile, so the banner must remain unmounted (landing seed hygiene
      // would also null it; the prompt alone already refuses to project).
      mocks.providers = limitedAmbientAndWork();
      rerender(
        <LoadingSeedHarness
          profileId="stale-managed-id"
          selectedModel={SONNET}
        />,
      );
      await macrotaskTick();
      expect(screen.getByTestId("banner-visible").textContent).toBe("false");
      expect(
        screen.queryByRole("region", { name: "Rate-limit profile switch" }),
      ).toBeNull();
    });
  });

  describe("2. all-exhausted stability", () => {
    it("stays in read-only View profile limits and never auto-switches across re-renders", async () => {
      mocks.providers = [
        claudeState([
          profile({
            profileId: "ambient",
            kind: "ambient",
            label: "Terminal account",
            rateLimitStatus: "hard_limit",
            rateLimitLimitedScopes: null,
            authenticated: true,
          }),
          profile({
            profileId: "work",
            kind: "managed",
            label: "Work",
            rateLimitStatus: "hard_limit",
            rateLimitLimitedScopes: null,
            authenticated: true,
          }),
        ]),
      ];
      const toolbarStore = createLandingToolbarStore(null);
      const { rerender } = render(
        <LandingRateLimitBannerHarness
          toolbarStore={toolbarStore}
          selectedModel={SONNET}
          active
        />,
      );
      expect(screen.getByTestId("banner-visible").textContent).toBe("true");
      expect(
        screen.getByRole("button", { name: "View profile limits" }),
      ).toBeDefined();
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(screen.queryByRole("button", { name: /Switch to/ })).toBeNull();

      for (let index = 0; index < 5; index += 1) {
        act(() => {
          rerender(
            <LandingRateLimitBannerHarness
              toolbarStore={toolbarStore}
              selectedModel={SONNET}
              active
            />,
          );
        });
        await macrotaskTick();
      }
      expect(screen.getByTestId("profile-id").textContent).toBe("ambient");
      expect(toolbarStore.getState().selection.profileId).toBeNull();
      expect(
        screen.getByRole("button", { name: "View profile limits" }),
      ).toBeDefined();
    });
  });

  describe("3. dismissal semantics (shared store)", () => {
    it("hides on dismiss, re-arms on material warningKey change, and shares dismissal with a chat surface", async () => {
      mocks.providers = limitedAmbientAndWork();
      const toolbarStore = createLandingToolbarStore(null);
      const { rerender } = render(
        <DualSurfaceHarness
          toolbarStore={toolbarStore}
          selectedModel={SONNET}
        />,
      );
      expect(screen.getByTestId("banner-visible").textContent).toBe("true");
      expect(screen.getByTestId("chat-banner-visible").textContent).toBe(
        "true",
      );

      // Dismiss from the chat surface first - landing must suppress too.
      const chatRegion = screen.getAllByRole("region", {
        name: "Rate-limit profile switch",
      })[1];
      fireEvent.click(
        within(chatRegion).getByRole("button", {
          name: "Dismiss rate-limit suggestion",
        }),
      );
      await macrotaskTick();
      expect(screen.getByTestId("banner-visible").textContent).toBe("false");
      expect(screen.getByTestId("chat-banner-visible").textContent).toBe(
        "false",
      );
      expect(
        screen.queryByRole("region", { name: "Rate-limit profile switch" }),
      ).toBeNull();

      // Same key again: stays dismissed.
      rerender(
        <DualSurfaceHarness
          toolbarStore={toolbarStore}
          selectedModel={SONNET}
        />,
      );
      await macrotaskTick();
      expect(screen.getByTestId("banner-visible").textContent).toBe("false");

      // Material severity change re-arms both surfaces.
      mocks.providers = [
        claudeState([
          profile({
            profileId: "ambient",
            kind: "ambient",
            label: "Terminal account",
            rateLimitStatus: "near_limit",
            rateLimitLimitedScopes: null,
            authenticated: true,
          }),
          profile({
            profileId: "work",
            kind: "managed",
            label: "Work",
            rateLimitStatus: "ok",
            rateLimitLimitedScopes: null,
            authenticated: true,
          }),
        ]),
      ];
      // Start from near_limit visible, dismiss, then flip to hard_limit.
      useRateLimitSwitchPromptDismissalsStore.setState({
        dismissedKeys: new Set<string>(),
      });
      rerender(
        <DualSurfaceHarness
          toolbarStore={toolbarStore}
          selectedModel={SONNET}
        />,
      );
      await macrotaskTick();
      expect(screen.getByTestId("banner-visible").textContent).toBe("true");
      fireEvent.click(
        screen.getAllByRole("button", {
          name: "Dismiss rate-limit suggestion",
        })[0],
      );
      await macrotaskTick();
      expect(screen.getByTestId("banner-visible").textContent).toBe("false");

      mocks.providers = limitedAmbientAndWork();
      rerender(
        <DualSurfaceHarness
          toolbarStore={toolbarStore}
          selectedModel={SONNET}
        />,
      );
      await macrotaskTick();
      expect(screen.getByTestId("banner-visible").textContent).toBe("true");
      expect(screen.getByTestId("chat-banner-visible").textContent).toBe(
        "true",
      );
    });
  });

  describe("4. switch correctness (toolbar store + epic.create payload)", () => {
    it("primary CTA commits to the landing toolbar store and buildChatRunSettings carries the switched profileId", async () => {
      mocks.providers = limitedAmbientAndWork();
      const toolbarStore = createLandingToolbarStore(null);
      render(
        <LandingRateLimitBannerHarness
          toolbarStore={toolbarStore}
          selectedModel={SONNET}
          active
        />,
      );
      expect(screen.getByTestId("profile-id").textContent).toBe("ambient");
      expect(screen.getByTestId("submit-profile-id").textContent).toBe(
        "ambient",
      );

      fireEvent.click(screen.getByRole("button", { name: "Switch to Work" }));
      await macrotaskTick();

      expect(screen.getByTestId("profile-id").textContent).toBe("work");
      expect(toolbarStore.getState().selection.profileId).toBe("work");
      expect(screen.getByTestId("submit-profile-id").textContent).toBe("work");
      // Same builder `use-landing-composer-actions` uses at submit time.
      expect(
        buildChatRunSettings({
          selection: toolbarStore.getState().selection,
          permission: toolbarStore.getState().permission,
          reasoning: toolbarStore.getState().reasoning,
          serviceTier: toolbarStore.getState().serviceTier,
          agentMode: toolbarStore.getState().agentMode,
        }).profileId,
      ).toBe("work");
      // Task checkbox never appears on landing (affectedChatCount 0).
      expect(screen.queryByRole("checkbox")).toBeNull();
    });

    it("destination chooser commits a non-primary selectable profile to the landing toolbar store", async () => {
      mocks.providers = [
        claudeState([
          profile({
            profileId: "ambient",
            kind: "ambient",
            label: "Terminal account",
            rateLimitStatus: "hard_limit",
            rateLimitLimitedScopes: null,
            authenticated: true,
          }),
          profile({
            profileId: "first",
            kind: "managed",
            label: "First",
            rateLimitStatus: "ok",
            rateLimitLimitedScopes: null,
            authenticated: true,
          }),
          profile({
            profileId: "second",
            kind: "managed",
            label: "Second",
            rateLimitStatus: "ok",
            rateLimitLimitedScopes: null,
            authenticated: true,
          }),
        ]),
      ];
      const toolbarStore = createLandingToolbarStore(null);
      render(
        <LandingRateLimitBannerHarness
          toolbarStore={toolbarStore}
          selectedModel={SONNET}
          active
        />,
      );
      // Primary is First; open the chooser (Radix opens on pointerDown) and
      // pick Second via its accessible menu row name.
      expect(
        screen.getByRole("button", { name: "Switch to First" }),
      ).toBeDefined();
      fireEvent.pointerDown(
        screen.getByRole("button", { name: "Choose another profile" }),
      );
      await macrotaskTick();
      fireEvent.click(
        screen.getByRole("menuitem", {
          name: /Second, Not checked, Available to switch/,
        }),
      );
      await macrotaskTick();
      expect(screen.getByTestId("profile-id").textContent).toBe("second");
      expect(toolbarStore.getState().selection.profileId).toBe("second");
      expect(
        buildChatRunSettings({
          selection: toolbarStore.getState().selection,
          permission: toolbarStore.getState().permission,
          reasoning: toolbarStore.getState().reasoning,
          serviceTier: toolbarStore.getState().serviceTier,
          agentMode: toolbarStore.getState().agentMode,
        }).profileId,
      ).toBe("second");
    });
  });

  describe("5. model scoping (real prompt + rate-limit-scope-match)", () => {
    const fableLimited = profile({
      profileId: "ambient",
      kind: "ambient",
      label: "Work",
      rateLimitStatus: "near_limit",
      rateLimitLimitedScopes: [{ family: "Fable", severity: "near_limit" }],
      authenticated: true,
    });
    const healthy = profile({
      profileId: "other",
      kind: "managed",
      label: "Other",
      rateLimitStatus: "ok",
      rateLimitLimitedScopes: [],
      authenticated: true,
    });
    const fableOnlyDestination = profile({
      profileId: "fable-only",
      kind: "managed",
      label: "Fable only",
      rateLimitStatus: "near_limit",
      rateLimitLimitedScopes: [{ family: "Fable", severity: "near_limit" }],
      authenticated: true,
    });

    it("does not show the banner when only a non-selected model family is limited", async () => {
      mocks.providers = [claudeState([fableLimited, healthy])];
      const toolbarStore = createLandingToolbarStore(null);
      render(
        <LandingRateLimitBannerHarness
          toolbarStore={toolbarStore}
          selectedModel={OPUS}
          active
        />,
      );
      await macrotaskTick();
      expect(screen.getByTestId("banner-visible").textContent).toBe("false");
      expect(
        screen.queryByRole("region", { name: "Rate-limit profile switch" }),
      ).toBeNull();
    });

    it("shows the banner for the selected limited family and keeps a family-only-limited destination selectable", async () => {
      // Current is shared-window limited; destination limited only on Fable.
      // With Opus selected, Fable-only must remain selectable (not poisoned).
      mocks.providers = [
        claudeState([
          profile({
            profileId: "ambient",
            kind: "ambient",
            label: "Current",
            rateLimitStatus: "near_limit",
            rateLimitLimitedScopes: [{ family: null, severity: "near_limit" }],
            authenticated: true,
          }),
          fableOnlyDestination,
        ]),
      ];
      const toolbarStore = createLandingToolbarStore(null);
      render(
        <LandingRateLimitBannerHarness
          toolbarStore={toolbarStore}
          selectedModel={OPUS}
          active
        />,
      );
      await macrotaskTick();
      expect(screen.getByTestId("banner-visible").textContent).toBe("true");
      expect(
        screen.getByRole("button", { name: "Switch to Fable only" }),
      ).toBeDefined();

      fireEvent.click(
        screen.getByRole("button", { name: "Switch to Fable only" }),
      );
      await macrotaskTick();
      expect(toolbarStore.getState().selection.profileId).toBe("fable-only");
    });

    it("shows a Fable-scoped warning when Fable is selected (real scope match)", async () => {
      mocks.providers = [claudeState([fableLimited, healthy])];
      const toolbarStore = createLandingToolbarStore(null);
      const { rerender } = render(
        <LandingRateLimitBannerHarness
          toolbarStore={toolbarStore}
          selectedModel={FABLE}
          active
        />,
      );
      await macrotaskTick();
      expect(screen.getByTestId("banner-visible").textContent).toBe("true");
      expect(screen.getByText(/Fable/)).toBeDefined();

      rerender(
        <LandingRateLimitBannerHarness
          toolbarStore={toolbarStore}
          selectedModel={OPUS}
          active
        />,
      );
      await macrotaskTick();
      expect(screen.getByTestId("banner-visible").textContent).toBe("false");
    });
  });

  describe("6. hostile labels through the landing mount", () => {
    it.each([
      ["2000-char label", VERY_LONG_LABEL],
      ["RTL override + control chars", RTL_CONTROL_LABEL],
      ["HTML-looking label", HTML_LOOKING_LABEL],
      ["script-tag-looking label", SCRIPT_LOOKING_LABEL],
    ])(
      "renders %s as escaped text with a complete accessible name",
      async (_name, label) => {
        mocks.providers = [
          claudeState([
            profile({
              profileId: "ambient",
              kind: "ambient",
              label: "Current",
              rateLimitStatus: "hard_limit",
              rateLimitLimitedScopes: null,
              authenticated: true,
            }),
            profile({
              profileId: "target",
              kind: "managed",
              label,
              rateLimitStatus: "ok",
              rateLimitLimitedScopes: null,
              authenticated: true,
            }),
          ]),
        ];
        const toolbarStore = createLandingToolbarStore(null);
        const { container } = render(
          <LandingRateLimitBannerHarness
            toolbarStore={toolbarStore}
            selectedModel={SONNET}
            active
          />,
        );
        await macrotaskTick();
        expect(
          screen.getByRole("button", { name: `Switch to ${label}` }),
        ).toBeDefined();
        expect(container.querySelector("img")).toBeNull();
        expect(container.querySelector("script")).toBeNull();
        expect(container.textContent).toContain(label);
      },
    );
  });
});
