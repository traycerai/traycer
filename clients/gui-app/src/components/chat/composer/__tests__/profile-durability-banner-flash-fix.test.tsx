import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "zustand";
import { vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";

/**
 * Banner-flash bug: switching chat tabs (a real ChatTile remount past the
 * keep-alive LRU) or creating a new chat via its first message briefly
 * flashes "This chat's Codex profile is no longer available", then self-
 * corrects. Root cause (confirmed): `chat-composer.tsx` seeds its toolbar
 * store with `settingsSeed ?? fallbackSettingsSeed`. Before the chat's own
 * authoritative settings hydrate (fresh mount, or a brand-new chat with
 * `settings: null`), the FALLBACK - composer-run-settings-store's epic/
 * global last-run, a landing draft's frozen snapshot, ... - feeds
 * `useProviderReauthGate`. That fallback is zustand-persisted, NOT host-
 * scoped, and can carry a stale/host-mismatched non-null `profileId`, which
 * `deriveReauthReason` correctly (but wrongly, for THIS purpose) reports as
 * "profile_missing" for a selection the chat never actually owned.
 *
 * Two-prong fix under test here, wired exactly like `chat-composer.tsx`:
 *  1. GATE - `useProviderReauthGate`'s new `authoritative` param: `false`
 *     for a fallback-derived selection, so `profile_missing`/
 *     `profile_unauthenticated` never fire from it.
 *  2. SEED HYGIENE - `useComposerToolbarStore`'s new `client` param:
 *     validates every seed (authoritative or fallback) against the target
 *     host's live `providers.list` via `resolveSeededProfileId`, nulling a
 *     genuinely-absent profile instead of trusting it verbatim.
 */

const mocks = vi.hoisted(() => ({
  // Feeds `useTabProvidersList` (the reauth gate's OWN query).
  tabProviders: [] as ProviderCliState[],
  // Feeds `useHostQuery` (used inside `useResolvedSeededProfileId`, called by
  // `useComposerToolbarStore`), keyed by the exact `client` reference it was
  // invoked with - so a decoy client's data can never leak into the result
  // unless the code under test genuinely reads from it.
  providersByClient: new Map<unknown, ProviderCliState[]>(),
}));

vi.mock("@/hooks/providers/use-tab-providers-list-query", () => ({
  useTabProvidersList: (activity: { enabled: boolean }) =>
    activity.enabled
      ? { data: { providers: mocks.tabProviders } }
      : { data: undefined },
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => TAB_HOST_CLIENT,
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "tab-host",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: {
    readonly client: unknown;
    readonly options: { readonly enabled: boolean } | null;
  }) => {
    if (!(args.options?.enabled ?? false)) return { data: undefined };
    const providers = mocks.providersByClient.get(args.client);
    return { data: providers === undefined ? undefined : { providers } };
  },
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () => ({
    data: {
      harnesses: [
        {
          id: "claude",
          label: "Claude Code",
          available: true,
          error: null,
          modes: ["gui", "tui"],
          requiresApiKey: false,
          supportedPermissionModes: ["supervised"],
        },
      ],
    },
    isPending: false,
  }),
  useGuiHarnessModelsQuery: () => ({
    data: {
      models: [
        {
          harnessId: "claude",
          slug: "sonnet-4.5",
          label: "Sonnet",
          description: null,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          metadata: {},
        },
      ],
    },
    isPending: false,
  }),
}));

import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { authoritativeOrFallbackSeedSource } from "@/lib/composer/composer-seed-source";
import { useProviderReauthGate } from "../use-provider-reauth-gate";

function buildHostClient(hostId: string): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    // `useHostQuery` is mocked wholesale above, so this messenger's handlers
    // are never actually invoked - this just needs to be a real, distinct
    // `HostClient` instance to key `mocks.providersByClient` by.
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${hostId}`,
      handlers: {},
    }),
  });
  client.bind({
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl: `ws://127.0.0.1:0/${hostId}`,
    version: "0.0.0-mock",
    status: "available",
  });
  return client;
}

// The tab's own host - the ONLY host this composer's turns actually run on.
const TAB_HOST_CLIENT = buildHostClient("tab-host");
// A decoy "host A" - a DIFFERENT host that a stale/cross-session fallback
// pin might have been minted on. Never wired to anything the composer
// actually reads from; its data proves cross-host isolation by being the
// OPPOSITE of the tab host's, in each direction.
const DECOY_HOST_A_CLIENT = buildHostClient("host-a");

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

function providerState(
  providerId: ProviderId,
  profiles: ProviderProfile[],
): ProviderCliState {
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
    profiles,
  };
}

function claudeState(profiles: ProviderProfile[]): ProviderCliState {
  return providerState("claude-code", profiles);
}

const STALE_FALLBACK_SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "sonnet-4.5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  // Minted on a different host/session and now dead on the tab host - the
  // exact shape composer-run-settings-store's epic/global last-run, or a
  // frozen landing-draft snapshot, can carry.
  profileId: "stale-codex-id",
};

const AUTHORITATIVE_MISSING_SETTINGS: ChatRunSettings = {
  ...STALE_FALLBACK_SETTINGS,
  // A genuinely different id, so this test's control case is unambiguous.
  profileId: "genuinely-missing-uuid",
};

/**
 * Mirrors `chat-composer.tsx`'s wiring exactly: computes one `seedSource`
 * (authoritative when `settingsSeed` is non-null, else a fallback seeded
 * from `fallbackSettingsSeed`) and feeds the SAME discriminant to both the
 * toolbar store and the reauth gate - this is exactly the shared signal that
 * keeps prong 2 (seed hygiene) from fighting prong 1 (the gate) over a
 * genuinely-pinned, genuinely-missing profile (see the CONTROL test).
 */
function ChatComposerLikeHarness(props: {
  readonly settingsSeed: ChatRunSettings | null;
  readonly fallbackSettingsSeed: ChatRunSettings | null;
}) {
  const seedSource = authoritativeOrFallbackSeedSource(
    props.settingsSeed,
    props.fallbackSettingsSeed,
    TAB_HOST_CLIENT,
  );
  const toolbarStore = useComposerToolbarStore(null, seedSource, null, false);
  const harnessId = useStore(toolbarStore, (s) => s.selection.harnessId);
  const profileId = useStore(toolbarStore, (s) => s.selection.profileId);
  const reauthGate = useProviderReauthGate(
    harnessId,
    profileId,
    true,
    seedSource.kind,
  );
  return (
    <div>
      <div data-testid="profile-id">{profileId ?? "ambient"}</div>
      <div data-testid="send-blocked">{String(reauthGate.signedOut)}</div>
      <div data-testid="reason">{reauthGate.reason ?? "none"}</div>
    </div>
  );
}

describe("banner-flash fix: fallback-vs-authoritative gate + host-scoped seed hygiene", () => {
  beforeEach(() => {
    mocks.tabProviders = [];
    mocks.providersByClient.clear();
  });
  afterEach(() => cleanup());

  it("(a) tab-switch flash: settingsSeed=null + a stale fallback profileId shows no profile_missing banner, then stays clean once authoritative settings arrive", () => {
    // Tab host's live claude profiles do NOT include "stale-codex-id" (it's
    // settled and real - not merely unloaded).
    mocks.tabProviders = [
      claudeState([profile("ambient", "ambient", "Terminal account")]),
    ];
    mocks.providersByClient.set(TAB_HOST_CLIENT, [
      claudeState([profile("ambient", "ambient", "Terminal account")]),
    ]);

    const { rerender } = render(
      <ChatComposerLikeHarness
        settingsSeed={null}
        fallbackSettingsSeed={STALE_FALLBACK_SETTINGS}
      />,
    );

    // FIX (both prongs land on the same observable outcome here): the
    // fallback-derived selection never accuses itself of being missing
    // (prong 1), AND seed hygiene has already nulled the dead pin (prong 2)
    // - so nothing is even authoritatively "missing" to complain about.
    expect(screen.getByTestId("send-blocked").textContent).toBe("false");
    expect(screen.getByTestId("reason").textContent).toBe("none");
    expect(screen.getByTestId("profile-id").textContent).toBe("ambient");

    // The chat's own authoritative settings arrive (post-snapshot), re-
    // seeding with `profileId: null` - the self-correction the bug report
    // observed. Still no banner.
    rerender(
      <ChatComposerLikeHarness
        settingsSeed={{ ...STALE_FALLBACK_SETTINGS, profileId: null }}
        fallbackSettingsSeed={STALE_FALLBACK_SETTINGS}
      />,
    );
    expect(screen.getByTestId("send-blocked").textContent).toBe("false");
    expect(screen.getByTestId("reason").textContent).toBe("none");
  });

  it("(b) new-chat path: a brand-new chat (settings: null) seeded the same way shows no flash either", () => {
    // A brand-new chat's `chat.settings` is null until the first turn - the
    // GUI represents this identically to the pre-snapshot window above
    // (`settingsSeed: null`), so it is the SAME code path. This test pins
    // that the new-chat entry point isn't accidentally wired differently.
    mocks.tabProviders = [
      claudeState([profile("ambient", "ambient", "Terminal account")]),
    ];
    mocks.providersByClient.set(TAB_HOST_CLIENT, [
      claudeState([profile("ambient", "ambient", "Terminal account")]),
    ]);

    render(
      <ChatComposerLikeHarness
        settingsSeed={null}
        fallbackSettingsSeed={STALE_FALLBACK_SETTINGS}
      />,
    );

    expect(screen.getByTestId("send-blocked").textContent).toBe("false");
    expect(screen.getByTestId("reason").textContent).toBe("none");
  });

  it("(c) CONTROL: an authoritative settingsSeed with a genuinely missing pinned profile still shows the banner", () => {
    mocks.tabProviders = [
      claudeState([profile("ambient", "ambient", "Terminal account")]),
    ];
    mocks.providersByClient.set(TAB_HOST_CLIENT, [
      claudeState([profile("ambient", "ambient", "Terminal account")]),
    ]);

    render(
      <ChatComposerLikeHarness
        settingsSeed={AUTHORITATIVE_MISSING_SETTINGS}
        fallbackSettingsSeed={null}
      />,
    );

    // The chat's OWN settings really do pin a dead profile - this is the
    // real feature, and the fix must not weaken it.
    expect(screen.getByTestId("send-blocked").textContent).toBe("true");
    expect(screen.getByTestId("reason").textContent).toBe("profile_missing");
  });

  it("(d) fallback with a VALID profileId on the tab host is preserved, not false-nulled", () => {
    const validFallback: ChatRunSettings = {
      ...STALE_FALLBACK_SETTINGS,
      profileId: "work-uuid",
    };
    mocks.tabProviders = [
      claudeState([
        profile("ambient", "ambient", "Terminal account"),
        profile("work-uuid", "managed", "Work"),
      ]),
    ];
    mocks.providersByClient.set(TAB_HOST_CLIENT, [
      claudeState([
        profile("ambient", "ambient", "Terminal account"),
        profile("work-uuid", "managed", "Work"),
      ]),
    ]);

    render(
      <ChatComposerLikeHarness
        settingsSeed={null}
        fallbackSettingsSeed={validFallback}
      />,
    );

    // Seed hygiene (prong 2) confirms the profile is genuinely alive on the
    // tab host and keeps it - a live fallback pin is not something either
    // prong should ever clear.
    expect(screen.getByTestId("profile-id").textContent).toBe("work-uuid");
    expect(screen.getByTestId("send-blocked").textContent).toBe("false");
  });

  it("(e) host-env mismatch: a fallback pin valid on a DECOY host but absent on the tab host never flashes, and seed hygiene resolves it to ambient", () => {
    // The decoy "host A" (never wired to anything the composer reads from)
    // has "stale-codex-id" alive - proving that if the composer ever
    // accidentally read from the wrong host, this test would catch it (the
    // assertions below would flip).
    mocks.providersByClient.set(DECOY_HOST_A_CLIENT, [
      claudeState([
        profile("ambient", "ambient", "Terminal account"),
        profile("stale-codex-id", "managed", "Company"),
      ]),
    ]);
    // The TAB host (host B, the real target) settled WITHOUT it.
    mocks.tabProviders = [
      claudeState([profile("ambient", "ambient", "Terminal account")]),
    ];
    mocks.providersByClient.set(TAB_HOST_CLIENT, [
      claudeState([profile("ambient", "ambient", "Terminal account")]),
    ]);

    render(
      <ChatComposerLikeHarness
        settingsSeed={null}
        fallbackSettingsSeed={STALE_FALLBACK_SETTINGS}
      />,
    );

    // Prong 1: no flash regardless (non-authoritative).
    expect(screen.getByTestId("send-blocked").textContent).toBe("false");
    expect(screen.getByTestId("reason").textContent).toBe("none");
    // Prong 2: resolved against the TAB host's own data (settled, absent) -
    // not the decoy host's (settled, present) - so it nulls to ambient.
    expect(screen.getByTestId("profile-id").textContent).toBe("ambient");
  });
});
