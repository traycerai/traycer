import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import {
  resolveRateLimitProfileId,
  resolveStatusBarProfileIds,
  useRateLimitProfileSelection,
  type RateLimitProfileSelection,
} from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useLayoutStore } from "@/stores/settings/layout-store";

function profile(
  profileId: string,
  kind: ProviderProfile["kind"],
): ProviderProfile {
  return {
    profileId,
    enabled: true,
    kind,
    authType: "oauth",
    label: kind === "ambient" ? "Terminal" : profileId,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: {
      email: `${profileId}@example.com`,
      tier: "Pro",
      accountUuid: `${profileId}-uuid`,
    },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

// The host lists the ambient login FIRST; the strip draws it LAST.
const CODEX_PROFILES = [
  profile("ambient", "ambient"),
  profile("personal-profile", "managed"),
  profile("work-profile", "managed"),
];

const CLAUDE_PROFILES = [
  profile("ambient", "ambient"),
  profile("claude-work", "managed"),
];

function selection(
  overrides: Partial<RateLimitProfileSelection>,
): RateLimitProfileSelection {
  return {
    shownProfiles: {},
    lastProfileByHarness: {},
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  useComposerHarnessMemoryStore.getState().resetForTests();
  useLayoutStore.setState(useLayoutStore.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  useComposerHarnessMemoryStore.getState().resetForTests();
  useLayoutStore.setState(useLayoutStore.getInitialState(), true);
});

describe("resolveStatusBarProfileIds", () => {
  it("draws every checked account in the provider's order, ambient last", () => {
    expect(
      resolveStatusBarProfileIds(
        selection({
          // Checked in one order, listed by the host in another.
          shownProfiles: { codex: ["work-profile", null, "personal-profile"] },
        }),
        "codex",
        CODEX_PROFILES,
      ),
    ).toEqual(["personal-profile", "work-profile", null]);
  });

  it("skips a checked id whose profile no longer exists rather than drawing ambient for it", () => {
    expect(
      resolveStatusBarProfileIds(
        selection({
          shownProfiles: { codex: ["removed-profile", "work-profile"] },
        }),
        "codex",
        CODEX_PROFILES,
      ),
    ).toEqual(["work-profile"]);
  });

  it("falls back to ONE account - last-used on this host - when nothing checked survives", () => {
    const stale = selection({
      shownProfiles: { codex: ["removed-profile"] },
      lastProfileByHarness: { codex: "personal-profile" },
    });
    expect(resolveStatusBarProfileIds(stale, "codex", CODEX_PROFILES)).toEqual([
      "personal-profile",
    ]);
    // And the same with nothing checked at all.
    expect(
      resolveStatusBarProfileIds(
        selection({ lastProfileByHarness: { codex: "personal-profile" } }),
        "codex",
        CODEX_PROFILES,
      ),
    ).toEqual(["personal-profile"]);
  });

  it("falls through a stale last-used id to the provider's first profile, and to ambient with no profiles", () => {
    // The remembered id is gone: not ambient, but the next rule - and the
    // host's first profile here IS the ambient row, which reads as `null`.
    expect(
      resolveStatusBarProfileIds(
        selection({ lastProfileByHarness: { claude: "removed-profile" } }),
        "claude-code",
        CLAUDE_PROFILES,
      ),
    ).toEqual([null]);
    expect(
      resolveStatusBarProfileIds(
        selection({ lastProfileByHarness: { claude: "removed-profile" } }),
        "claude-code",
        [profile("claude-work", "managed")],
      ),
    ).toEqual(["claude-work"]);
    expect(
      resolveStatusBarProfileIds(
        selection({ shownProfiles: { grok: ["anything"] } }),
        "grok",
        [],
      ),
    ).toEqual([null]);
  });

  it("checks are per provider: another provider's checks do not leak across", () => {
    const shared = selection({
      shownProfiles: { codex: ["work-profile"] },
      lastProfileByHarness: { claude: "claude-work" },
    });
    expect(resolveStatusBarProfileIds(shared, "codex", CODEX_PROFILES)).toEqual(
      ["work-profile"],
    );
    expect(
      resolveStatusBarProfileIds(shared, "claude-code", CLAUDE_PROFILES),
    ).toEqual(["claude-work"]);
  });

  it("resolveRateLimitProfileId is the first of what the strip draws", () => {
    expect(
      resolveRateLimitProfileId(
        selection({ shownProfiles: { codex: [null, "work-profile"] } }),
        "codex",
        CODEX_PROFILES,
      ),
    ).toBe("work-profile");
    expect(
      resolveRateLimitProfileId(selection({}), "codex", CODEX_PROFILES),
    ).toBe(null);
  });
});

describe("useRateLimitProfileSelection", () => {
  it("reads the checked accounts and the last-used memory for the host it is given, and only that host", () => {
    const memory = useComposerHarnessMemoryStore.getState();
    memory.recordProfileSelection("host-a", "codex", "personal-profile");
    memory.recordProfileSelection("host-b", "codex", "work-profile");
    const layout = useLayoutStore.getState();
    layout.setStatusBarProfileShown(
      "host-a",
      "claude-code",
      "claude-work",
      true,
    );
    layout.setStatusBarProfileShown("host-b", "codex", null, true);

    const initialProps: { readonly hostId: string | null } = {
      hostId: "host-a",
    };
    const { result, rerender } = renderHook(
      (props: { readonly hostId: string | null }) =>
        useRateLimitProfileSelection(props.hostId),
      { initialProps },
    );

    expect(result.current).toEqual({
      shownProfiles: { "claude-code": ["claude-work"] },
      lastProfileByHarness: { codex: "personal-profile" },
    });

    // A host switch swaps the whole set.
    rerender({ hostId: "host-b" });
    expect(result.current).toEqual({
      shownProfiles: { codex: [null] },
      lastProfileByHarness: { codex: "work-profile" },
    });

    // No host: nothing checked, nothing remembered.
    rerender({ hostId: null });
    expect(result.current).toEqual({
      shownProfiles: {},
      lastProfileByHarness: {},
    });
  });

  it("re-renders when a check is written for its host and keeps identity otherwise", () => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useRateLimitProfileSelection("host-a");
    });
    const settled = renderCount;
    const before = result.current.shownProfiles;

    act(() => {
      useLayoutStore
        .getState()
        .setStatusBarProfileShown("host-b", "codex", "work-profile", true);
    });
    // Another host's entry is not this surface's business.
    expect(result.current.shownProfiles).toBe(before);

    act(() => {
      useLayoutStore
        .getState()
        .setStatusBarProfileShown("host-a", "codex", "work-profile", true);
    });
    expect(renderCount).toBeGreaterThan(settled);
    expect(result.current.shownProfiles).toEqual({ codex: ["work-profile"] });
  });
});
