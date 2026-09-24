import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { StrictMode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type ProvidersFallbackPolicyGetResponse,
  type ProvidersFallbackPolicySetResponse,
} from "@traycer/protocol/host/fallback-policy";
import {
  HostRpcError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";

/**
 * Parent-level reset / Undo for the Overrides tab, against the live reducer.
 * Only the host boundary (query and mutation hooks) and host scope are faked,
 * as in `fallback-settings-panel.test.tsx`.
 */
const mocks = vi.hoisted(
  (): {
    queryData: ProvidersFallbackPolicyGetResponse | undefined;
    setMutateAsync: Mock<
      (input: {
        readonly policy: FallbackPolicy;
      }) => Promise<ProvidersFallbackPolicySetResponse>
    >;
    refetch: Mock<
      () => Promise<{
        isSuccess: boolean;
        data: ProvidersFallbackPolicyGetResponse | undefined;
      }>
    >;
  } => ({ queryData: undefined, setMutateAsync: vi.fn(), refetch: vi.fn() }),
);

vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const host = hostScopeOptionFixture({ hostId: "host-a", name: "Test Host" });
  return {
    useHostScope: () =>
      hostScopeFixture({
        hosts: [host],
        host,
        hostId: host.hostId,
        hostLabel: host.name,
        activeHost: host,
        isViewingActive: true,
        status: "following",
        client: null,
      }),
  };
});
vi.mock("@/hooks/providers/use-fallback-policy-query", () => ({
  useFallbackPolicyQuery: () => ({
    isError: false,
    data: mocks.queryData,
    refetch: mocks.refetch,
  }),
}));
vi.mock("@/hooks/providers/use-fallback-in-flight-count-query", () => ({
  useFallbackInFlightCountQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/providers/use-fallback-policy-set-mutation", () => ({
  useFallbackPolicySetMutation: () => ({ mutateAsync: mocks.setMutateAsync }),
}));
vi.mock("@/hooks/providers/use-fallback-policy-reset-mutation", () => ({
  useFallbackPolicyResetMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock(
  "@/hooks/providers/use-fallback-policy-restore-tier-groups-mutation",
  () => ({
    useFallbackPolicyRestoreTierGroupsMutation: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
  }),
);
vi.mock(
  "@/hooks/providers/use-fallback-policy-preview-tier-groups-query",
  () => ({
    useFallbackPolicyPreviewTierGroupsQuery: () => ({
      data: undefined,
      isFetching: false,
    }),
  }),
);
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({ data: undefined }),
}));
vi.mock(
  "@/components/settings/panels/fallback/fallback-catalog-options",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/settings/panels/fallback/fallback-catalog-options")
      >();
    return {
      ...actual,
      useFallbackCatalogOptions: () => ({
        modelsFor: () => [],
        effortsFor: () => [],
      }),
    };
  },
);
vi.mock(
  "@/components/chat/fallback/fallback-identity",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/chat/fallback/fallback-identity")
      >();
    return {
      ...actual,
      useFallbackModelLabels: () => (_harnessId: string, model: string) =>
        model,
    };
  },
);
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() },
}));

import { FallbackSettingsPanel } from "@/components/settings/panels/fallback-settings-panel";
import {
  openFallbackTab,
  renderWithFallbackQueryClient,
} from "@/components/settings/panels/__tests__/fallback-settings-panel-test-support";

function policy(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return { ...createDefaultFallbackPolicy(), enabled: true, ...overrides };
}

const CUSTOM = policy({
  reasonOverrides: {
    rate_limit: ["profile", "notify"],
    billing: ["notify"],
  },
});
const RATE_LIMIT_MESSAGE = "Rate limit reached now follows the main plan.";

function respond(value: FallbackPolicy): ProvidersFallbackPolicyGetResponse {
  return { policy: value, storedPolicyUnreadable: false, inFlightCount: 0 };
}

function deferredSave(): {
  readonly settle: (value: FallbackPolicy) => void;
  readonly reject: (error: Error) => void;
} {
  let settle: (value: FallbackPolicy) => void = () => {};
  let reject: (error: Error) => void = () => {};
  mocks.setMutateAsync.mockImplementationOnce(
    () =>
      new Promise((resolve, rejectPromise) => {
        settle = (value) => {
          resolve({ policy: value });
        };
        reject = rejectPromise;
      }),
  );
  return {
    settle: (value) => settle(value),
    reject: (error) => reject(error),
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function renderOverrides(): void {
  renderWithFallbackQueryClient(
    <StrictMode>
      <FallbackSettingsPanel />
    </StrictMode>,
  );
  openFallbackTab("overrides");
}

function useMainPlanForRateLimit(): void {
  fireEvent.click(screen.getByRole("button", { name: /^Rate limit reached/ }));
  fireEvent.click(screen.getByRole("button", { name: /Use main plan/ }));
}

function lastSentPolicy(): FallbackPolicy {
  const call = mocks.setMutateAsync.mock.calls.at(-1);
  if (call === undefined) throw new Error("no save was sent");
  return call[0].policy;
}

beforeEach(() => {
  mocks.queryData = respond(CUSTOM);
  mocks.setMutateAsync.mockReset();
  mocks.refetch.mockReset();
  mocks.refetch.mockImplementation(() =>
    Promise.resolve({ isSuccess: true, data: mocks.queryData }),
  );
});

afterEach(() => {
  cleanup();
});

describe("FallbackSettingsPanel overrides - reset and Undo", () => {
  it("a per-problem reset saves only that override's removal", () => {
    deferredSave();
    renderOverrides();
    useMainPlanForRateLimit();
    expect(lastSentPolicy().reasonOverrides).toEqual({ billing: ["notify"] });
  });

  it("offers Undo only after the reset is confirmed, and Undo restores just that override", async () => {
    const save = deferredSave();
    renderOverrides();
    useMainPlanForRateLimit();
    const after = policy({ reasonOverrides: { billing: ["notify"] } });
    save.settle(after);
    await flush();

    expect(screen.getByText(RATE_LIMIT_MESSAGE)).not.toBeNull();
    const undo = screen.getByRole("button", { name: "Undo" });
    expect((undo as HTMLButtonElement).disabled).toBe(false);

    deferredSave();
    fireEvent.click(undo);
    expect(lastSentPolicy().reasonOverrides).toEqual(CUSTOM.reasonOverrides);
  });

  it("does not offer an enabled Undo while the reset is still pending", () => {
    deferredSave();
    renderOverrides();
    useMainPlanForRateLimit();
    const undo = screen.queryByRole("button", { name: "Undo" });
    // Either withheld or disabled, never a live control on an unconfirmed save.
    if (undo !== null) expect((undo as HTMLButtonElement).disabled).toBe(true);
    const sent = mocks.setMutateAsync.mock.calls.length;
    if (undo !== null) fireEvent.click(undo);
    expect(mocks.setMutateAsync.mock.calls.length).toBe(sent);
  });

  it("withholds Undo when the reset is refused", async () => {
    const save = deferredSave();
    renderOverrides();
    useMainPlanForRateLimit();
    save.reject(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "refused",
        requestId: "req-refused",
        method: "providers.fallbackPolicy.set",
        fatalDetails: null,
      }),
    );
    await flush();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByText(RATE_LIMIT_MESSAGE)).toBeNull();
  });

  it("withholds a blind Undo when the reset's outcome is unknown", async () => {
    const save = deferredSave();
    renderOverrides();
    useMainPlanForRateLimit();
    save.reject(
      new HostTransportFailureError({
        code: "RPC_ERROR",
        message: "lost the connection",
        requestId: "req-unknown",
        method: "providers.fallbackPolicy.set",
        fatalDetails: null,
      }),
    );
    await flush();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("a later edit invalidates Undo", async () => {
    const save = deferredSave();
    renderOverrides();
    useMainPlanForRateLimit();
    save.settle(policy({ reasonOverrides: { billing: ["notify"] } }));
    await flush();
    expect(screen.getByRole("button", { name: "Undo" })).not.toBeNull();

    // Edit a different problem: this is the next policy edit.
    deferredSave();
    fireEvent.click(screen.getByRole("button", { name: /^Billing issue/ }));
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Try another account for Billing issue",
      }),
    );
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByText(RATE_LIMIT_MESSAGE)).toBeNull();
  });

  it("Reset all clears every override, including stored ones on read-only problems, and is offered Undo once confirmed", async () => {
    mocks.queryData = respond(
      policy({
        reasonOverrides: {
          rate_limit: ["profile", "notify"],
          provider_connection_failed: ["notify"],
        },
      }),
    );
    const save = deferredSave();
    renderOverrides();
    fireEvent.click(
      screen.getByRole("button", { name: "Reset all to main plan" }),
    );
    expect(lastSentPolicy().reasonOverrides).toBeUndefined();
    save.settle(policy({}));
    await flush();
    expect(
      screen.getByText("All problems now follow the main plan."),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).not.toBeNull();
  });
});

describe("FallbackSettingsPanel overrides - Changes saved", () => {
  const SAVED = "Changes saved";

  function uncheckWait(): void {
    fireEvent.click(
      screen.getByRole("button", { name: /^Rate limit reached/ }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Wait for the limit to reset for Rate limit reached",
      }),
    );
  }

  it("shows Changes saved only after the latest displayed policy is confirmed", async () => {
    const save = deferredSave();
    renderOverrides();
    uncheckWait();
    expect(screen.queryByText(SAVED)).toBeNull();
    save.settle(lastSentPolicy());
    await flush();
    expect(screen.getByText(SAVED)).not.toBeNull();
  });

  it("never shows Changes saved for a refused save, or for an unknown save whose successful read-back returns the old value", async () => {
    const refused = deferredSave();
    renderOverrides();
    uncheckWait();
    refused.reject(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "refused",
        requestId: "req-refused",
        method: "providers.fallbackPolicy.set",
        fatalDetails: null,
      }),
    );
    await flush();
    expect(screen.queryByText(SAVED)).toBeNull();
    cleanup();

    const lost = deferredSave();
    renderOverrides();
    uncheckWait();
    lost.reject(
      new HostTransportFailureError({
        code: "RPC_ERROR",
        message: "lost the connection",
        requestId: "req-unknown",
        method: "providers.fallbackPolicy.set",
        fatalDetails: null,
      }),
    );
    // The read-back resolves with the ORIGINAL policy (the default refetch
    // mock), which the reducer adopts as confirmed; that is not the submitted
    // edit, so it must not be reported as saved.
    await flush();
    await flush();
    expect(mocks.refetch).toHaveBeenCalled();
    expect(screen.queryByText(SAVED)).toBeNull();
  });

  it("does not claim Changes saved while a newer edit is still pending", async () => {
    const first = deferredSave();
    renderOverrides();
    uncheckWait();
    const firstSent = lastSentPolicy();
    deferredSave();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Try an equivalent model for Rate limit reached",
      }),
    );
    first.settle(firstSent);
    await flush();
    expect(screen.queryByText(SAVED)).toBeNull();
  });

  it("shows Changes saved after a confirmed Undo, and not while it is pending", async () => {
    const reset = deferredSave();
    renderOverrides();
    useMainPlanForRateLimit();
    reset.settle(policy({ reasonOverrides: { billing: ["notify"] } }));
    await flush();

    const undoSave = deferredSave();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.queryByText(SAVED)).toBeNull();
    undoSave.settle(lastSentPolicy());
    await flush();
    expect(screen.getByText(SAVED)).not.toBeNull();
  });
});
