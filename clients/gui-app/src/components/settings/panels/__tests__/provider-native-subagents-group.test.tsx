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
import { ProviderNativeSubagentsGroup } from "@/components/settings/panels/provider-native-subagents-group";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";

const CLAUDE_HARNESS_ID = providerIdToGuiHarnessId("claude-code");

// The group gates on the WRITE method and on the `providers.list` line that
// publishes the value. The negotiated-manifest registry is the real one; only
// the host id is mocked, so these cases exercise `useHostMethodSupport` and
// `useHostMethodSchemaVersion` rather than stand-ins for them.
const HOST_ID = vi.hoisted(() => "host-provider-native-subagents");
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => HOST_ID,
}));

type SetNativeSubagentsVariables = {
  readonly harnessId: string;
  readonly nativeSubagents: boolean;
};
type SetNativeSubagentsCallbacks = { readonly onError: () => void };
const mutateMock = vi.hoisted(() =>
  vi.fn<
    (
      variables: SetNativeSubagentsVariables,
      callbacks: SetNativeSubagentsCallbacks,
    ) => void
  >(),
);
const setNativeSubagentsMock = vi.hoisted(() => ({
  mutate: mutateMock,
  isPending: false,
}));
vi.mock(
  "@/hooks/providers/use-providers-set-native-subagents-mutation",
  () => ({
    useProvidersSetNativeSubagents: () => setNativeSubagentsMock,
  }),
);

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
    "providers.setNativeSubagents": { major: 1, minor: 0 },
    "providers.list": { major: 10, minor: 5 },
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  providersUpdatedAt.current = 1_000;
  setNativeSubagentsMock.isPending = false;
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
    ...overrides,
  };
}

function nativeSwitch(): HTMLElement {
  return screen.getByTestId("provider-native-subagents-switch");
}

describe("<ProviderNativeSubagentsGroup />", () => {
  it("renders nothing when the host does not advertise providers.setNativeSubagents", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "providers.list": { major: 10, minor: 5 },
    });

    render(<ProviderNativeSubagentsGroup state={providerState({})} />);

    expect(screen.queryByTestId("provider-native-subagents-group")).toBeNull();
  });

  it("renders nothing when providers.list is negotiated below the line that publishes the value", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "providers.setNativeSubagents": { major: 1, minor: 0 },
      "providers.list": { major: 10, minor: 4 },
    });

    render(<ProviderNativeSubagentsGroup state={providerState({})} />);

    expect(screen.queryByTestId("provider-native-subagents-group")).toBeNull();
  });

  it("renders a checked switch for a row without the key, and an unchecked one for nativeSubagents: false", () => {
    const { rerender } = render(
      <ProviderNativeSubagentsGroup state={providerState({})} />,
    );
    expect(screen.getByTestId("provider-native-subagents-group")).toBeTruthy();
    expect(nativeSwitch().getAttribute("aria-checked")).toBe("true");

    rerender(
      <ProviderNativeSubagentsGroup
        state={providerState({ nativeSubagents: false })}
      />,
    );
    expect(nativeSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("sends {harnessId, nativeSubagents: false} on flip and shows the echo until providers.list re-lands", () => {
    const { rerender } = render(
      <ProviderNativeSubagentsGroup state={providerState({})} />,
    );

    fireEvent.click(nativeSwitch());

    expect(mutateMock.mock.calls.length).toBe(1);
    const [variables, callbacks] = mutateMock.mock.calls[0];
    expect(variables).toEqual({
      harnessId: CLAUDE_HARNESS_ID,
      nativeSubagents: false,
    });
    expect(typeof callbacks.onError).toBe("function");
    // The fixture still says nothing was stored, yet the switch shows the pick.
    expect(nativeSwitch().getAttribute("aria-checked")).toBe("false");

    // Same stored value, same fetch stamp: the echo holds across a re-render.
    rerender(<ProviderNativeSubagentsGroup state={providerState({})} />);
    expect(nativeSwitch().getAttribute("aria-checked")).toBe("false");

    // providers.list re-landed (stamp advanced) still saying "unset": the
    // authoritative read wins and the echo retires.
    providersUpdatedAt.current = 2_000;
    rerender(<ProviderNativeSubagentsGroup state={providerState({})} />);
    expect(nativeSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("restores the stored value when the write is refused", () => {
    render(<ProviderNativeSubagentsGroup state={providerState({})} />);

    fireEvent.click(nativeSwitch());
    expect(nativeSwitch().getAttribute("aria-checked")).toBe("false");

    act(() => {
      mutateMock.mock.calls[0][1].onError();
    });

    expect(nativeSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("disables the switch while the write is pending", () => {
    setNativeSubagentsMock.isPending = true;

    render(<ProviderNativeSubagentsGroup state={providerState({})} />);

    expect(nativeSwitch().hasAttribute("disabled")).toBe(true);
    fireEvent.click(nativeSwitch());
    expect(mutateMock).not.toHaveBeenCalled();
  });
});
