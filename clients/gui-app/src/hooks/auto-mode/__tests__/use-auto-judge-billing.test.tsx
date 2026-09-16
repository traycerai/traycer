import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  type ProviderCliState,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { AutoJudgeGetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import { guiHarnessOptionSchema } from "@traycer/protocol/host/agent/gui/unary-schemas";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { useAutoJudgeBilling } from "@/hooks/auto-mode/use-auto-judge-billing";

const CLAUDE_HARNESS_ID = providerIdToGuiHarnessId("claude-code");

/**
 * The banned app-wide hook. Its own doc says a tab must never call it
 * (root AGENTS.md: "Tabs bind a `hostId` for life… Never use
 * `useAddressableHostId()` inside a tab"), and this hook is mounted by the
 * chat tab's composer toolbar - so the spy below is not a restatement of
 * production logic, it asserts a dependency this hook must never reach for
 * again. It used to fall back to exactly this hook for the `null`-target
 * case.
 */
const useAddressableHostIdMock = vi.hoisted(() =>
  vi.fn((): string | null => "app-wide-host-should-never-be-read"),
);
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => useAddressableHostIdMock(),
}));

/**
 * A client is opaque here - only its identity matters, since
 * `useReactiveHostReadiness` below is the one thing that turns it back into a
 * host id. Carrying the requested `hostId` on the object is what lets the
 * readiness mock answer truthfully without a real `HostClient`.
 */
type FakeClient = { readonly requestedHostId: string | null };

const useHostClientForHostIdMock = vi.hoisted(() =>
  vi.fn((hostId: string | null): FakeClient => ({ requestedHostId: hostId })),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    useHostClientForHostIdMock(hostId),
}));

/**
 * The FOLLOWING client's own host, modelled the way the real one behaves: a
 * client resolved for `null` is the app's following requester, and asking IT
 * which host it addresses answers a concrete id rather than `null`. That is
 * the whole substitution this hook made - the name used to come from
 * `useAddressableHostId()`, which reads the app-wide SELECTION, and now comes
 * from the client the query is already running on.
 */
const FOLLOWING_HOST_ID = "following-host";

const useReactiveHostReadinessMock = vi.hoisted(() =>
  vi.fn((client: FakeClient | null) => ({
    hostId:
      client === null ? null : (client.requestedHostId ?? FOLLOWING_HOST_ID),
    requestContextUserId: null,
    isReady: client !== null,
    hasRpcEndpoint: client !== null,
    canExecute: client !== null,
  })),
);
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: FakeClient | null) =>
    useReactiveHostReadinessMock(client),
}));

const useHostSupportsMethodMock = vi.hoisted(() =>
  vi.fn((_hostId: string | null, _method: string): boolean => true),
);
// The negotiated `providers.list` line, which decides whether the stored
// per-provider judge is READABLE at all (`autoJudge` rides `9.1`). `9.1` is the
// default here so every pre-existing case keeps meaning what it did - they are
// about the two settled reads, not about the version - and the case that is
// about it sets its own.
const providersListVersion = vi.hoisted(() => ({
  current: { major: 9, minor: 1 } as { major: number; minor: number } | null,
}));

// The negotiated `agent.gui.listHarnesses` line - the JOB 3 proof that lets
// the catalog reads run without `autoJudge.get`. Defaulted to the 9.1 line
// (the one `catalogLineKnowsAutoMode` requires) so every pre-existing case
// keeps meaning what it did: they are about the two settled reads and the
// getter's own support flag, not about this line.
const listHarnessesVersion = vi.hoisted(() => ({
  current: { major: 9, minor: 1 } as { major: number; minor: number } | null,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (hostId: string | null, method: string) =>
    useHostSupportsMethodMock(hostId, method),
  useHostMethodSchemaVersion: (_hostId: string | null, method: string) => {
    if (method === "providers.list") return providersListVersion.current;
    if (method === "agent.gui.listHarnesses")
      return listHarnessesVersion.current;
    return null;
  },
}));

let autoJudgeGetData: AutoJudgeGetResponse | undefined;
const useHostQueryMock = vi.hoisted(() =>
  vi.fn<() => { data: AutoJudgeGetResponse | undefined }>(),
);
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => useHostQueryMock(),
}));

let providersListData: { providers: ProviderCliState[] } | undefined;
const useProvidersListForClientMock = vi.hoisted(() =>
  vi.fn<
    (
      client: FakeClient | null,
      activity: { readonly enabled: boolean; readonly subscribed: boolean },
    ) => {
      data: { providers: ProviderCliState[] } | undefined;
      isSuccess: boolean;
      isError: boolean;
    }
  >(),
);
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: (
    client: FakeClient | null,
    activity: { readonly enabled: boolean; readonly subscribed: boolean },
  ) => useProvidersListForClientMock(client, activity),
}));

// The native-judge CAPABILITY half. The hook now gates `provider-native` on the
// catalog row's `nativeAutoJudge` as well as the persisted override, because
// the override is a preference that outlives the capability. Defaulted to
// capable and settled so the cases below still turn on what they are about.
let harnessesData: { harnesses: GuiHarnessOption[] } | undefined;
let harnessesSettled = true;
// Forwards its ARGUMENTS, like the `providers.list` mock beside it. The hook
// decides which enablement to ask each catalog for, and a stub that swallows
// that argument cannot tell "the gate moved" from "the mock answers whatever
// happens" - which is exactly the hole the `autoModeHost` case below closes.
const useGuiHarnessesQueryForClientMock = vi.hoisted(() =>
  vi.fn<
    (
      client: FakeClient | null,
      activity: { readonly enabled: boolean; readonly subscribed: boolean },
    ) => {
      data: { harnesses: GuiHarnessOption[] } | undefined;
      isSuccess: boolean;
      isError: boolean;
    }
  >(),
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: (
    client: FakeClient | null,
    activity: { readonly enabled: boolean; readonly subscribed: boolean },
  ) => useGuiHarnessesQueryForClientMock(client, activity),
  // The judge harness's model list. Declared EXPLICITLY rather than left off:
  // a partial module mock throws on the first access, so every case in this
  // file died at import when the hook grew this read. `data: undefined` is the
  // honest default here - "the catalog has not answered" - which
  // `judgeModelUnavailable` reads as "cannot say", so existing cases keep the
  // billing answer they were written for and the model dimension is exercised
  // only where a case opts in.
  useGuiHarnessModelsQueryForClient: () => judgeModelsQueryMock(),
}));

const judgeModelsQueryMock = vi.fn<
  () => {
    readonly data:
      | { readonly models: ReadonlyArray<{ slug: string }> }
      | undefined;
  }
>(() => ({ data: undefined }));

function harnessRow(nativeAutoJudge: boolean): GuiHarnessOption {
  return guiHarnessOptionSchema.parse({
    id: CLAUDE_HARNESS_ID,
    label: "Claude Code",
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    nativeAutoJudge,
  });
}

function providerState(overrides: Partial<ProviderCliState>): ProviderCliState {
  return {
    providerId: "claude-code",
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
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
    ...overrides,
  };
}

/** A minimal `ProviderProfile` fixture for the FIX 3 profile-availability case below. */
function providerProfile(profileId: string): ProviderProfile {
  return {
    profileId,
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label: profileId,
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
    ambientDriftNotice: null,
    accentColor: null,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  providersListVersion.current = { major: 9, minor: 1 };
  listHarnessesVersion.current = { major: 9, minor: 1 };
  autoJudgeGetData = undefined;
  providersListData = undefined;
  harnessesData = { harnesses: [harnessRow(true)] };
  harnessesSettled = true;
  useGuiHarnessesQueryForClientMock.mockImplementation(() => ({
    data: harnessesData,
    isSuccess: harnessesSettled,
    isError: false,
  }));
  useHostQueryMock.mockImplementation(() => ({ data: autoJudgeGetData }));
  useProvidersListForClientMock.mockImplementation(() => ({
    data: providersListData,
    // The hook now waits for this read to SETTLE, not merely to have data:
    // classifying on an unanswered catalog is what made the mobile row publish
    // Traycer-credits copy that later flipped. Every existing case here models
    // a catalog that has already answered.
    isSuccess: true,
    isError: false,
  }));
  // Re-established every test, like its three siblings above: a case that
  // opts into a concrete judge-model catalog via `.mockReturnValue` must not
  // leak that catalog into the next test's default "cannot say" read.
  judgeModelsQueryMock.mockReturnValue({ data: undefined });
});

useHostQueryMock.mockImplementation(() => ({ data: autoJudgeGetData }));
useProvidersListForClientMock.mockImplementation(() => ({
  data: providersListData,
  isSuccess: true,
  isError: false,
}));
harnessesData = { harnesses: [harnessRow(true)] };
useGuiHarnessesQueryForClientMock.mockImplementation(() => ({
  data: harnessesData,
  isSuccess: harnessesSettled,
  isError: false,
}));

describe("useAutoJudgeBilling", () => {
  it("never reads the app-wide host via useAddressableHostId - that dependency is banned inside a tab", () => {
    autoJudgeGetData = { selection: null };
    providersListData = { providers: [] };

    renderHook(() => useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID));

    expect(useAddressableHostIdMock).not.toHaveBeenCalled();
  });

  it("asks the capability gate about the CLIENT's own host, not some other host", () => {
    autoJudgeGetData = { selection: null };
    providersListData = { providers: [] };

    renderHook(() => useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID));

    // The client was resolved for "host-b", and the gate must be asked about
    // exactly that id - never the id `useHostClientForHostId` was CALLED
    // with in isolation, and never a second, independently-read host name.
    // This is the assertion that would have caught the two-sources defect:
    // before the fix, the gate could be asked about the app-wide selection
    // while the query still ran on this client.
    expect(useHostSupportsMethodMock).toHaveBeenCalledWith(
      "host-b",
      "autoJudge.get",
    );
    const askedHosts = useHostSupportsMethodMock.mock.calls.map(
      (call) => call[0],
    );
    expect(askedHosts).not.toContain("app-wide-host-should-never-be-read");
  });

  // The branch that actually changed, and the only one where the fallback's
  // VALUE is observable. The two cases above pass a concrete `host-b`, which
  // short-circuits the fallback entirely - they would pass against the old code
  // too, on the gate assertion alone. With a `null` target the old code asked
  // the gate about `useAddressableHostId()`'s answer (the app-wide selection);
  // the new code asks the client this hook already resolved. So this is the
  // positive half of the ban: not "the banned hook wasn't called", but "the
  // right host was named instead".
  it("names the FOLLOWING client's own host for a null target, never the app-wide selection", () => {
    autoJudgeGetData = { selection: null };
    providersListData = { providers: [] };

    renderHook(() => useAutoJudgeBilling(null, CLAUDE_HARNESS_ID));

    expect(useHostSupportsMethodMock).toHaveBeenCalledWith(
      FOLLOWING_HOST_ID,
      "autoJudge.get",
    );
    const askedHosts = useHostSupportsMethodMock.mock.calls.map(
      (call) => call[0],
    );
    expect(askedHosts).not.toContain("app-wide-host-should-never-be-read");
  });

  it("returns null before the record has loaded", () => {
    autoJudgeGetData = undefined;
    providersListData = { providers: [] };

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
    );

    expect(result.current).toBeNull();
  });

  // The end-to-end shape of the JOB 3 defect: the host-wide selection is
  // Traycer's judge (unset, which `autoJudgeBillingFor` folds into
  // "traycer"), but the RUN harness's own provider row says it reviews its
  // own commands - so the composer must disclose "provider-native", not
  // "Uses your Traycer credits." for a call that will never be made.
  it("resolves to provider-native when the host-wide selection is Traycer but the run harness's provider reviews its own commands", () => {
    autoJudgeGetData = { selection: null };
    providersListData = {
      providers: [providerState({ autoJudge: "provider" })],
    };

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
    );

    expect(result.current).toEqual({
      kind: "provider-native",
      harnessId: CLAUDE_HARNESS_ID,
      harnessLabel: "Claude Code",
    });
  });

  // JOB 4, end-to-end: the persisted override says "provider", but the
  // harness catalog row for this run's harness is not capable
  // (`nativeAutoJudge: false`) - a preference outliving the capability (a
  // host downgrade, or the provider losing the feature). The hook must fall
  // back to the host-wide (Traycer) reading rather than disclosing a
  // classifier that no longer exists.
  it("falls back to the traycer reading when the provider override says 'provider' but the catalog row is not capable", () => {
    autoJudgeGetData = { selection: null };
    providersListData = {
      providers: [providerState({ autoJudge: "provider" })],
    };
    harnessesData = { harnesses: [harnessRow(false)] };

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
    );

    expect(result.current).toEqual({ kind: "traycer" });
  });

  // JOB 3, end-to-end: `autoJudge.get` reports both a stored selection AND a
  // blocker on it. The hook must fold that into `{ kind: "blocked" }` rather
  // than billing the stored (but unrunnable) provider selection - the same
  // precedence `autoJudgeBillingForRun` encodes, exercised through the real
  // read path this composer surface actually uses.
  it("resolves to blocked when autoJudge.get reports a selection together with a blocker", () => {
    autoJudgeGetData = {
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
      },
      blocked: { reason: "provider-disabled" },
    };
    providersListData = { providers: [] };

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
    );

    expect(result.current).toEqual({ kind: "blocked" });
  });

  // FIX 3 (P2): the stored judge names an explicit profile its provider no
  // longer offers. The host's `blocked` field has no member for this - it is
  // a purely client-side comparison against the LIVE `providers.list` read -
  // so before this fix the row kept claiming the provider account would be
  // charged for a judge call that was never going to happen (every command
  // escalates to the human instead, exactly like the host-blocked case
  // above).
  it("resolves to blocked when the stored judge names a profile the provider no longer offers", () => {
    autoJudgeGetData = {
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: "removed-profile",
      },
    };
    providersListData = {
      providers: [
        providerState({ profiles: [providerProfile("kept-profile")] }),
      ],
    };

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
    );

    expect(result.current).toEqual({ kind: "blocked" });
  });

  // Control: the same stored judge, with the SAME profile still present in
  // the provider's offered list - proves the case above fires on the
  // profile comparison and not merely on having an external (non-traycer)
  // judge harness stored.
  it("still bills the provider account when the stored judge's profile is still offered", () => {
    autoJudgeGetData = {
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: "kept-profile",
      },
    };
    providersListData = {
      providers: [
        providerState({ profiles: [providerProfile("kept-profile")] }),
      ],
    };

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
    );

    expect(result.current).toEqual({
      kind: "provider",
      harnessId: "claude",
      harnessLabel: "Claude Code",
    });
  });

  // FIX 2 (P2): the sibling of the profile-unavailable case above, one field
  // over - the stored judge's MODEL has left its harness's own catalog rather
  // than its provider's profile list. `judgeModelUnavailable` has no display
  // fallback to compare against (unlike the picker's store), so the hook asks
  // the harness's model catalog directly - the read this module mock declares
  // explicitly above so a partial-mock throw doesn't kill every case here.
  it("resolves to blocked when the stored judge names a model its harness no longer lists", () => {
    autoJudgeGetData = {
      selection: {
        harnessId: "claude",
        model: "gone-model",
        profileId: null,
      },
    };
    providersListData = {
      providers: [providerState({})],
    };
    judgeModelsQueryMock.mockReturnValue({
      data: { models: [{ slug: "kept-model" }] },
    });

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
    );

    expect(result.current).toEqual({ kind: "blocked" });
  });

  // Control: the same stored judge, with the SAME model still present in its
  // harness's catalog - proves the case above fires on the model comparison
  // and not merely on having an external (non-traycer) judge harness stored.
  it("still bills the provider account when the stored judge's model is still offered", () => {
    autoJudgeGetData = {
      selection: {
        harnessId: "claude",
        model: "kept-model",
        profileId: null,
      },
    };
    providersListData = {
      providers: [providerState({})],
    };
    judgeModelsQueryMock.mockReturnValue({
      data: { models: [{ slug: "kept-model" }] },
    });

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
    );

    expect(result.current).toEqual({
      kind: "provider",
      harnessId: "claude",
      harnessLabel: "Claude Code",
    });
  });

  // JOB 2: the ordering defect itself. `autoJudge.get` has already resolved,
  // but the `providers.list` read - cold on the mobile toolbar, since no
  // picker there has warmed it - has not. Classifying on data alone here is
  // exactly what published "Uses your Traycer credits" and then flipped it
  // once the providers rows landed; the hook must wait instead.
  describe("waits for providers.list to settle before publishing billing copy", () => {
    it("returns null while autoJudge.get has data but providers.list is still in flight", () => {
      autoJudgeGetData = { selection: null };
      useProvidersListForClientMock.mockImplementation(() => ({
        data: undefined,
        isSuccess: false,
        isError: false,
      }));

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
      );

      expect(result.current).toBeNull();
    });

    // Same inputs as above, settled: proves the `null` case is the WAIT and
    // not a permanent refusal once the provider read actually lands.
    it("resolves to provider-native once the providers read succeeds with a provider-native row", () => {
      autoJudgeGetData = { selection: null };
      useProvidersListForClientMock.mockImplementation(() => ({
        data: { providers: [providerState({ autoJudge: "provider" })] },
        isSuccess: true,
        isError: false,
      }));

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
      );

      expect(result.current).toEqual({
        kind: "provider-native",
        harnessId: CLAUDE_HARNESS_ID,
        harnessLabel: "Claude Code",
      });
    });

    // A FAILED read is not settled. This case previously asserted the
    // opposite - "an error still counts as settled, because a host that cannot
    // answer is what the `false` default is for" - and that rationale
    // conflated two hosts. The `false` (non-native) default exists for a host
    // that ANSWERS without the data: one predating `providers.list@9.1`, whose
    // successful response simply omits `autoJudge`. A transport failure says
    // nothing about the provider's classifier, and turning it into `false`
    // publishes "Uses your Traycer credits" for a run the host may well review
    // natively at no cost - a claim about the user's money, made from a read
    // that failed.
    //
    // "Hanging" was the wrong worry: the disclosure is ADDITIVE, so withholding
    // it renders the row exactly as it rendered before auto mode existed. There
    // is no spinner to hang and nothing is blocked - the honest answer to a
    // question we could not ask is to say nothing.
    it("keeps the disclosure hidden when the providers read fails", () => {
      autoJudgeGetData = { selection: null };
      useProvidersListForClientMock.mockImplementation(() => ({
        data: undefined,
        isSuccess: false,
        isError: true,
      }));

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
      );

      expect(result.current).toBeNull();
    });
  });

  // JOB 4: the harness catalog is the SECOND half of the native-judge
  // question, folded into the same settled gate as `providers.list` for the
  // same reason - classifying on an unanswered catalog is what published
  // stale billing copy that later flipped once the rows landed.
  describe("waits for the harness catalog to settle before publishing billing copy", () => {
    it("returns null while autoJudge.get has data but the harness catalog is still in flight", () => {
      autoJudgeGetData = { selection: null };
      providersListData = {
        providers: [providerState({ autoJudge: "provider" })],
      };
      harnessesData = undefined;
      harnessesSettled = false;
      useGuiHarnessesQueryForClientMock.mockImplementation(() => ({
        data: undefined,
        isSuccess: false,
        isError: false,
      }));

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
      );

      expect(result.current).toBeNull();
    });

    // JOB 4 (Codex, P1): the sibling of the `providers.list` failure case
    // above, and the SAME reasoning applies one field over. The `false`
    // (non-native) default `providerRunsItsOwnJudge` falls back to exists for
    // a host that ANSWERS without the data (one predating a catalog field),
    // not for a transport failure - so treating a failed harness-catalog read
    // as settled would publish "Uses your Traycer credits" for a run the host
    // may review natively at no cost, a claim about the user's money made
    // from a read that failed. `autoJudge.get` and `providers.list` both
    // succeed here, isolating the harness catalog as the one read that failed.
    it("keeps the disclosure hidden when the harness-catalog read fails, even though autoJudge.get and providers.list both succeeded", () => {
      autoJudgeGetData = { selection: null };
      providersListData = {
        providers: [providerState({ autoJudge: "provider" })],
      };
      harnessesData = undefined;
      harnessesSettled = false;
      useGuiHarnessesQueryForClientMock.mockImplementation(() => ({
        data: undefined,
        isSuccess: false,
        isError: true,
      }));

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
      );

      expect(result.current).toBeNull();
    });
  });

  // JOB 4: the THIRD unknown, `providerJudgeUnknown` - a version rather than a
  // read status. The catalog says this harness has a native judge to delegate
  // to, but `providers.list` is stuck at 9.0, which never carries `autoJudge`
  // back - so `providerAutoJudgeFor`'s `?? "traycer"` would answer for every
  // provider whatever the host actually has stored. The hook must publish
  // nothing rather than a possibly-wrong billing claim.
  describe("the writable-but-unreadable provider judge (providers.list stuck at 9.0)", () => {
    it("returns null when the harness has a native judge but providers.list cannot report it", () => {
      autoJudgeGetData = { selection: null };
      providersListData = {
        providers: [providerState({ autoJudge: "provider" })],
      };
      harnessesData = { harnesses: [harnessRow(true)] };
      providersListVersion.current = { major: 9, minor: 0 };

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
      );

      expect(result.current).toBeNull();
    });

    // Proves the gate is the PAIR ({nativeAutoJudge, list-version}), not the
    // list version alone: the same stuck-at-9.0 line is irrelevant when this
    // harness has no native judge to delegate to in the first place, since
    // `providerRunsItsOwnJudge` never consults `providerAutoJudgeFor` for it.
    it("is unaffected by the same stuck providers.list when the harness has no native judge", () => {
      autoJudgeGetData = { selection: null };
      providersListData = {
        providers: [providerState({ autoJudge: "provider" })],
      };
      harnessesData = { harnesses: [harnessRow(false)] };
      providersListVersion.current = { major: 9, minor: 0 };

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
      );

      expect(result.current).toEqual({ kind: "traycer" });
    });
  });

  // JOB 3: the catalog reads must not wait on `autoJudge.get` at all - they
  // are gated on the host having Auto mode AT ALL, proven either by the
  // getter's own support flag OR the negotiated `agent.gui.listHarnesses`
  // line. A host with `providers.list@9.1`, a native classifier and
  // `providers.setAutoJudge` but no `autoJudge.get` used to resolve `null`
  // here and omit the "no extra cost" disclosure for the one path that
  // bypasses the host-wide judge entirely.
  describe("resolves the provider-native path from the catalog alone, without autoJudge.get", () => {
    it("resolves provider-native when autoJudge.get is unsupported but the negotiated listHarnesses line proves Auto mode", () => {
      useHostSupportsMethodMock.mockImplementation(() => false);
      providersListData = {
        providers: [providerState({ autoJudge: "provider" })],
      };
      harnessesData = { harnesses: [harnessRow(true)] };

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
      );

      expect(result.current).toEqual({
        kind: "provider-native",
        harnessId: CLAUDE_HARNESS_ID,
        harnessLabel: "Claude Code",
      });
      // And the reads were actually ASKED for. The assertion above passes on a
      // mocked query whatever `enabled` the hook requested, so it alone cannot
      // tell "the gate moved off `autoJudge.get`" from "the mock answers
      // regardless" - re-gating the catalogs on the getter alone leaves it
      // green. This observes the request the hook makes, which is the decision
      // under test.
      expect(useProvidersListForClientMock).toHaveBeenCalledWith(
        expect.anything(),
        { enabled: true, subscribed: true },
      );
      expect(useGuiHarnessesQueryForClientMock).toHaveBeenCalledWith(
        expect.anything(),
        { enabled: true, subscribed: true },
      );
    });

    // The control: the same host, but the run harness has no native judge to
    // delegate to - this answer genuinely needs the host-wide selection,
    // which the host cannot report without `autoJudge.get`. Must stay null
    // rather than guessing.
    it("still answers null for a non-native harness when autoJudge.get is unsupported", () => {
      useHostSupportsMethodMock.mockImplementation(() => false);
      providersListData = {
        providers: [providerState({ autoJudge: "provider" })],
      };
      harnessesData = { harnesses: [harnessRow(false)] };

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
      );

      expect(result.current).toBeNull();
      // Null for the RIGHT reason: the catalogs were still read (this host has
      // Auto mode), and what is missing is only the host-wide selection.
      expect(useProvidersListForClientMock).toHaveBeenCalledWith(
        expect.anything(),
        { enabled: true, subscribed: true },
      );
    });
  });
});
