import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-schemas";
import { ProviderNativeMemoryGroup } from "@/components/settings/panels/provider-native-memory-group";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";

const CLAUDE_HARNESS_ID = providerIdToGuiHarnessId("claude-code");

// The group gates on three independent facts: the WRITE method, the
// providers.list line that publishes the pair, and the row's own
// nativeMemorySupported flag. The negotiated-manifest registry is the real
// one; only the host id is mocked, so these cases exercise
// `useHostMethodSupport` and `useHostMethodSchemaVersion` rather than
// stand-ins for them.
const HOST_ID = vi.hoisted(() => "host-provider-native-memory");
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => HOST_ID,
}));

type SetNativeMemoryVariables = {
  readonly harnessId: string;
  readonly nativeMemory: boolean;
};
type SetNativeMemoryCallbacks = { readonly onError: () => void };
const mutateMock = vi.hoisted(() =>
  vi.fn<
    (
      variables: SetNativeMemoryVariables,
      callbacks: SetNativeMemoryCallbacks,
    ) => void
  >(),
);
const setNativeMemoryMock = vi.hoisted(() => ({
  mutate: mutateMock,
  isPending: false,
}));
vi.mock("@/hooks/providers/use-providers-set-native-memory-mutation", () => ({
  useProvidersSetNativeMemory: () => setNativeMemoryMock,
}));

// Held constant: every echo case is "the refetch has not landed yet". Advancing
// it is how a case retires the echo without changing the stored value.
const providersUpdatedAt = vi.hoisted(() => ({ current: 1_000 }));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    dataUpdatedAt: providersUpdatedAt.current,
    isFetching: false,
  }),
}));

beforeEach(() => {
  recordNegotiatedHostManifest(HOST_ID, {
    "providers.setNativeMemory": { major: 1, minor: 0 },
    "providers.list": { major: 10, minor: 8 },
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  providersUpdatedAt.current = 1_000;
  setNativeMemoryMock.isPending = false;
  vi.clearAllMocks();
});

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
    nativeMemorySupported: true,
    ...overrides,
  };
}

function nativeSwitch(): HTMLElement {
  return screen.getByTestId("provider-native-memory-switch");
}

describe("<ProviderNativeMemoryGroup />", () => {
  it("renders nothing when the host does not advertise providers.setNativeMemory", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "providers.list": { major: 10, minor: 8 },
    });

    render(<ProviderNativeMemoryGroup state={providerState({})} />);

    expect(screen.queryByTestId("provider-native-memory-group")).toBeNull();
  });

  it("renders nothing when providers.list reports 10.7, even with nativeMemorySupported: true", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "providers.setNativeMemory": { major: 1, minor: 0 },
      "providers.list": { major: 10, minor: 7 },
    });

    render(
      <ProviderNativeMemoryGroup
        state={providerState({ nativeMemorySupported: true })}
      />,
    );

    expect(screen.queryByTestId("provider-native-memory-group")).toBeNull();
  });

  it("renders nothing when nativeMemorySupported is absent, even on a 10.8 host that supports the method", () => {
    render(
      <ProviderNativeMemoryGroup
        state={providerState({ nativeMemorySupported: undefined })}
      />,
    );

    expect(screen.queryByTestId("provider-native-memory-group")).toBeNull();
  });

  it("renders nothing when nativeMemorySupported is false", () => {
    render(
      <ProviderNativeMemoryGroup
        state={providerState({ nativeMemorySupported: false })}
      />,
    );

    expect(screen.queryByTestId("provider-native-memory-group")).toBeNull();
  });

  it("renders a checked switch for a row without nativeMemory, and an unchecked one for nativeMemory: false", () => {
    const { rerender } = render(
      <ProviderNativeMemoryGroup state={providerState({})} />,
    );
    expect(nativeSwitch().getAttribute("aria-checked")).toBe("true");

    rerender(
      <ProviderNativeMemoryGroup
        state={providerState({ nativeMemory: false })}
      />,
    );
    expect(nativeSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("labels the switch with the provider's display name", () => {
    render(<ProviderNativeMemoryGroup state={providerState({})} />);
    expect(nativeSwitch().getAttribute("aria-label")).toBe(
      "Use Claude Code memories",
    );
  });

  it("sends {harnessId, nativeMemory: false} on flip and shows the echo until providers.list re-lands", () => {
    const { rerender } = render(
      <ProviderNativeMemoryGroup state={providerState({})} />,
    );

    fireEvent.click(nativeSwitch());

    expect(mutateMock.mock.calls.length).toBe(1);
    const [variables] = mutateMock.mock.calls[0];
    expect(variables).toEqual({
      harnessId: CLAUDE_HARNESS_ID,
      nativeMemory: false,
    });
    // The fixture still says nothing was stored, yet the switch shows the pick.
    expect(nativeSwitch().getAttribute("aria-checked")).toBe("false");

    // Same stored value, same fetch stamp: the echo holds across a re-render.
    rerender(<ProviderNativeMemoryGroup state={providerState({})} />);
    expect(nativeSwitch().getAttribute("aria-checked")).toBe("false");

    // providers.list re-landed (stamp advanced) still saying "unset": the
    // authoritative read wins and the echo retires.
    providersUpdatedAt.current = 2_000;
    rerender(<ProviderNativeMemoryGroup state={providerState({})} />);
    expect(nativeSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("restores the stored value when the write is refused", () => {
    render(<ProviderNativeMemoryGroup state={providerState({})} />);

    fireEvent.click(nativeSwitch());
    expect(nativeSwitch().getAttribute("aria-checked")).toBe("false");

    act(() => {
      mutateMock.mock.calls[0][1].onError();
    });

    expect(nativeSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("disables the switch while the write is pending", () => {
    setNativeMemoryMock.isPending = true;

    render(<ProviderNativeMemoryGroup state={providerState({})} />);

    expect(nativeSwitch().hasAttribute("disabled")).toBe(true);
    fireEvent.click(nativeSwitch());
    expect(mutateMock).not.toHaveBeenCalled();
  });
});
