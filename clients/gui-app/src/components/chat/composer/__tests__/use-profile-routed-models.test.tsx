import { act, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
  ProviderProfileRateLimitStatus,
} from "@traycer/protocol/host/provider-schemas";
import type { ModelOption } from "@/components/home/data/landing-options";
import {
  useProfileRateLimitSwitchPrompt,
  type ProfileRateLimitSwitchPrompt,
} from "../use-profile-rate-limit-switch-prompt";
import { useRateLimitSwitchPromptDismissalsStore } from "@/stores/rate-limits/rate-limit-switch-prompt-dismissals-store";

const mocks = vi.hoisted(() => ({
  providers: [] as ProviderCliState[],
  supported: true,
  read: vi.fn<
    (params: object) => Promise<{
      routes: {
        profileId: string | null;
        resolvedModel: string;
        validForMs: number;
      }[];
    }>
  >(),
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: { providers: mocks.providers } }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => mocks.supported,
}));
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQueryWithResponseMap: (input: {
    method: string;
    params: object;
    options: { enabled: boolean; staleTime?: number };
    captureRequestContext: () => number;
    mapResponse: (input: {
      response: { routes: Route[] };
      requestContext: number;
    }) => object;
  }) =>
    useQuery(
      queryOptions({
        queryKey: [input.method, input.params],
        queryFn: async () => {
          const context = input.captureRequestContext();
          const response = await mocks.read(input.params);
          return input.mapResponse({ response, requestContext: context });
        },
        enabled: input.options.enabled,
        staleTime: input.options.staleTime,
        retry: false,
      }),
    ),
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
    enabled: true,
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
    accentColor: null,
    ambientDriftNotice: null,
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

function visiblePrompt(prompt: ProfileRateLimitSwitchPrompt) {
  if (prompt.kind !== "visible") {
    throw new Error("Expected a visible rate-limit switch prompt");
  }
  return prompt;
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
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [...profiles],
  };
}

const DEFAULT = model("default", "Default");
function setup(cwd: string | null, selectedModel: ModelOption) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 60_000 },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(
    ({ folder, selected }) =>
      useProfileRateLimitSwitchPrompt({
        workingDirectory: folder,
        hostId: "host-a",
        harnessId: "claude",
        profileId: null,
        selectedModel: selected,
        active: true,
        client: null,
      }),
    { wrapper, initialProps: { folder: cwd, selected: selectedModel } },
  );
  return { ...hook, client };
}
function limited(id: string, kind: "ambient" | "managed") {
  return profile({
    profileId: id,
    kind,
    label: id,
    rateLimitStatus: "hard_limit",
    rateLimitLimitedScopes: [{ family: "Fable", severity: "hard_limit" }],
    authenticated: true,
  });
}
function answer(
  profileId: string | null,
  resolvedModel: string,
  validForMs: number,
) {
  return { profileId, resolvedModel, validForMs };
}
type Route = {
  profileId: string | null;
  resolvedModel: string;
  validForMs: number;
};
let resolveRead: (value: { routes: Route[] }) => void;
let rejectRead: (error: Error) => void;
function pending() {
  return new Promise<{ routes: Route[] }>((resolve, reject) => {
    resolveRead = resolve;
    rejectRead = reject;
  });
}

describe("default model route evidence", () => {
  beforeEach(() => {
    mocks.supported = true;
    mocks.read.mockReset();
    mocks.providers = [
      claudeState([limited("ambient", "ambient"), limited("work", "managed")]),
    ];
    useRateLimitSwitchPromptDismissalsStore.setState({
      dismissedKeys: new Set<string>(),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("clears the cold warning once the ambient route resolves to Opus", async () => {
    mocks.read.mockImplementation(pending);
    const hook = setup("/repo", DEFAULT);
    expect(hook.result.current.kind).toBe("visible");
    act(() =>
      resolveRead({
        routes: [answer(null, "opus", 1000), answer("work", "fable", 1000)],
      }),
    );
    await waitFor(() => expect(hook.result.current.kind).toBe("hidden"));
  });
  it("assesses a managed Fable destination independently of the ambient route", async () => {
    mocks.providers = [
      claudeState([
        {
          ...limited("ambient", "ambient"),
          rateLimitLimitedScopes: [{ family: null, severity: "hard_limit" }],
        },
        limited("work", "managed"),
      ]),
    ];
    mocks.read.mockResolvedValue({
      routes: [answer(null, "opus", 1000), answer("work", "fable", 1000)],
    });
    const hook = setup("/repo", DEFAULT);
    await waitFor(() =>
      expect(
        hook.client
          .getQueryCache()
          .getAll()
          .some((query) => query.state.status === "success"),
      ).toBe(true),
    );
    expect(visiblePrompt(hook.result.current).destinations[0]?.selectable).toBe(
      false,
    );
  });
  it.each([
    [null, true],
    ["/repo", false],
  ] as const)(
    "does not request without a known folder or supported host",
    (folder, supported) => {
      mocks.supported = supported;
      const hook = setup(folder, DEFAULT);
      expect(hook.result.current.kind).toBe("visible");
      expect(mocks.read).not.toHaveBeenCalled();
    },
  );
  it("does not reuse a route when the folder changes", async () => {
    mocks.read
      .mockResolvedValueOnce({ routes: [answer(null, "opus", 1000)] })
      .mockImplementation(pending);
    const hook = setup("/one", DEFAULT);
    await waitFor(() => expect(hook.result.current.kind).toBe("hidden"));
    hook.rerender({ folder: "/two", selected: DEFAULT });
    expect(hook.result.current.kind).toBe("visible");
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  });
  it("restores the warning at expiry while refetch is pending and after failure", async () => {
    vi.useFakeTimers();
    mocks.read
      .mockResolvedValueOnce({ routes: [answer(null, "opus", 1000)] })
      .mockImplementation(pending);
    const hook = setup("/repo", DEFAULT);
    await act(async () => {
      await vi.waitFor(() => expect(hook.result.current.kind).toBe("hidden"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(hook.result.current.kind).toBe("visible");
    expect(mocks.read).toHaveBeenCalledTimes(2);
    await act(async () => {
      rejectRead(new Error("offline"));
      await vi.waitFor(() =>
        expect(
          hook.client
            .getQueryCache()
            .getAll()
            .some((query) => query.state.status === "error"),
        ).toBe(true),
      );
    });
    expect(hook.result.current.kind).toBe("visible");
  });
  it("re-reads an expired cached route when returning to a folder", async () => {
    vi.useFakeTimers();
    mocks.read
      .mockResolvedValueOnce({ routes: [answer(null, "opus", 1000)] })
      .mockImplementation(pending);
    const hook = setup("/one", DEFAULT);
    await act(async () => {
      await vi.waitFor(() => expect(hook.result.current.kind).toBe("hidden"));
    });
    hook.rerender({ folder: "/two", selected: DEFAULT });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    hook.rerender({ folder: "/one", selected: DEFAULT });
    expect(hook.result.current.kind).toBe("visible");
    expect(mocks.read).toHaveBeenCalledTimes(3);
  });
  it("does not grant a full new validity period to a delayed answer", async () => {
    vi.useFakeTimers();
    mocks.read.mockImplementation(pending);
    const hook = setup("/repo", DEFAULT);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    act(() => resolveRead({ routes: [answer(null, "opus", 1000)] }));
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          hook.client
            .getQueryCache()
            .getAll()
            .some((query) => query.state.status === "success"),
        ).toBe(true),
      );
    });
    expect(hook.result.current.kind).toBe("visible");
  });
  it("does not retry a successful zero-validity answer", async () => {
    vi.useFakeTimers();
    mocks.read.mockResolvedValue({ routes: [answer(null, "opus", 0)] });
    const hook = setup("/repo", DEFAULT);
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          hook.client
            .getQueryCache()
            .getAll()
            .some((query) => query.state.status === "success"),
        ).toBe(true),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(hook.result.current.kind).toBe("visible");
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });
  it("does not loop on repeated answers whose validity elapsed in flight", async () => {
    vi.useFakeTimers();
    mocks.read.mockImplementation(pending);
    const hook = setup("/one", DEFAULT);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    act(() => resolveRead({ routes: [answer(null, "opus", 1000)] }));
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          hook.client
            .getQueryCache()
            .getAll()
            .some((query) => query.state.status === "success"),
        ).toBe(true),
      );
    });
    hook.rerender({ folder: "/two", selected: DEFAULT });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    act(() => resolveRead({ routes: [answer(null, "opus", 1000)] }));
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          hook.client
            .getQueryCache()
            .getAll()
            .filter((query) => query.state.status === "success"),
        ).toHaveLength(2),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(hook.result.current.kind).toBe("visible");
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
  it("leaves explicit Opus ungated and shared limits visible", () => {
    const opus = setup("/repo", OPUS);
    expect(opus.result.current.kind).toBe("hidden");
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.providers = [
      claudeState([
        {
          ...limited("ambient", "ambient"),
          rateLimitLimitedScopes: [{ family: null, severity: "hard_limit" }],
        },
        limited("work", "managed"),
      ]),
    ];
    opus.rerender({ folder: "/repo", selected: OPUS });
    expect(opus.result.current.kind).toBe("visible");
  });
});
