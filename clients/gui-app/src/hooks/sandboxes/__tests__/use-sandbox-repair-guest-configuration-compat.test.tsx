import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { RequiredHostMethodVersion } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  SandboxRepairGuestConfigurationRequest,
  SandboxRepairGuestConfigurationResponse,
} from "@traycer/protocol/host/sandbox-egress";
import {
  recordNegotiatedHostMethods,
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The settings retry across host versions: only a host that negotiated
 * `host.sandbox.repairGuestConfiguration` 1.1 or later runs the combined retry
 * (and may be offered `Retry applying`); an unknown or 1.0 host keeps the
 * guest-only repair, which says nothing about whether settings applied.
 */

const HOST_ID = "host-compat";
const METHOD = "host.sandbox.repairGuestConfiguration";

const state = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => state.client,
}));

import {
  useSandboxRepairGuestConfigurationOnHost,
  useSandboxRepairGuestSetupOnHost,
  useSandboxGuestSetupRepairSupported,
  useSandboxRetryApplyingSupported,
  useSandboxSettingsOperation,
} from "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation";

function advertise(minor: number | null): void {
  recordNegotiatedHostManifest(
    HOST_ID,
    minor === null ? {} : { [METHOD]: { major: 1, minor } },
  );
}

const request = vi.fn();
const requestRequiring =
  vi.fn<
    (
      method: typeof METHOD,
      params: SandboxRepairGuestConfigurationRequest,
      signal: AbortSignal | undefined,
      requirement: RequiredHostMethodVersion,
    ) => Promise<SandboxRepairGuestConfigurationResponse>
  >();

function wrapperFor(queryClient: QueryClient) {
  return ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

beforeEach(() => {
  request.mockReset();
  requestRequiring.mockReset();
  state.client = Object.assign({} as HostRequester<HostRpcRegistry>, {
    request,
    requestWithSignalRequiringHostMethodVersion: requestRequiring,
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
});

describe("useSandboxRetryApplyingSupported", () => {
  it("is false before the host's handshake is known", () => {
    const { result } = renderHook(() =>
      useSandboxRetryApplyingSupported(HOST_ID),
    );
    expect(result.current).toBe(false);
  });

  it("is false when the host does not advertise the method", () => {
    advertise(null);
    const { result } = renderHook(() =>
      useSandboxRetryApplyingSupported(HOST_ID),
    );
    expect(result.current).toBe(false);
  });

  it("is false for a host that negotiated 1.0", () => {
    advertise(0);
    const { result } = renderHook(() =>
      useSandboxRetryApplyingSupported(HOST_ID),
    );
    expect(result.current).toBe(false);
  });

  it("is true for 1.1 and later, and follows a host upgraded in place", () => {
    advertise(0);
    const { result } = renderHook(() =>
      useSandboxRetryApplyingSupported(HOST_ID),
    );
    expect(result.current).toBe(false);
    act(() => advertise(1));
    expect(result.current).toBe(true);
    act(() => advertise(2));
    expect(result.current).toBe(true);
  });
});

describe("useSandboxGuestSetupRepairSupported", () => {
  function supported() {
    return renderHook(() => useSandboxGuestSetupRepairSupported(HOST_ID));
  }

  it("is false before the handshake is known, and for a name-only record that proves no version", () => {
    expect(supported().result.current).toBe(false);
    cleanup();
    recordNegotiatedHostMethods(HOST_ID, [METHOD]);
    expect(supported().result.current).toBe(false);
  });

  it("is false when the method is absent", () => {
    advertise(null);
    expect(supported().result.current).toBe(false);
  });

  it("is true for exactly 1.0, and false once the host serves the combined retry", () => {
    advertise(0);
    const { result } = supported();
    expect(result.current).toBe(true);
    act(() => advertise(1));
    expect(result.current).toBe(false);
  });
});

describe("useSandboxRepairGuestConfigurationOnHost", () => {
  it("dispatches the combined retry with an operation id, requiring 1.1", async () => {
    requestRequiring.mockResolvedValue({
      guestConfigured: true,
      guestConfigFailureReason: null,
      settingsApplied: true,
    });
    const { result } = renderHook(
      () => useSandboxRepairGuestConfigurationOnHost(HOST_ID),
      { wrapper: wrapperFor(newQueryClient()) },
    );

    await act(() => result.current.mutateAsync({}));

    expect(request).not.toHaveBeenCalled();
    expect(requestRequiring).toHaveBeenCalledTimes(1);
    const [method, params, , requirement] = requestRequiring.mock.calls[0];
    expect(method).toBe(METHOD);
    expect(typeof params.operationId).toBe("string");
    expect(params.operationId).not.toBe("");
    expect(requirement).toEqual({
      method: METHOD,
      version: { major: 1, minor: 1 },
    });
  });
});

describe("useSandboxRepairGuestSetupOnHost", () => {
  it("dispatches the guest-only repair at the 1.0 floor with no operation id", async () => {
    requestRequiring.mockResolvedValue({
      guestConfigured: true,
      guestConfigFailureReason: null,
      settingsApplied: false,
    });
    const { result } = renderHook(
      () => useSandboxRepairGuestSetupOnHost(HOST_ID),
      { wrapper: wrapperFor(newQueryClient()) },
    );

    await act(() => result.current.mutateAsync({}));

    const [method, params, , requirement] = requestRequiring.mock.calls[0];
    expect(method).toBe(METHOD);
    // The canonical 1.1 request; the 1.0 wire downgrade drops the null id.
    expect(params).toEqual({ operationId: null });
    expect(requirement).toEqual({
      method: METHOD,
      version: { major: 1, minor: 0 },
    });
  });

  it("never reports settings applied, even when a 1.1 host answers that it did", async () => {
    requestRequiring.mockResolvedValue({
      guestConfigured: true,
      guestConfigFailureReason: null,
      settingsApplied: true,
    });
    const { result } = renderHook(
      () => useSandboxRepairGuestSetupOnHost(HOST_ID),
      { wrapper: wrapperFor(newQueryClient()) },
    );

    await act(async () => {
      await result.current.mutateAsync({});
    });

    await waitFor(() =>
      expect(result.current.data).toEqual({
        guestConfigured: true,
        guestConfigFailureReason: null,
        settingsApplied: false,
      }),
    );
  });

  it("is not a settings operation: a guest-only repair never marks settings pending or failed", async () => {
    requestRequiring.mockResolvedValue({
      guestConfigured: false,
      guestConfigFailureReason: "prove",
      settingsApplied: false,
    });
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => ({
        repair: useSandboxRepairGuestSetupOnHost(HOST_ID),
        operation: useSandboxSettingsOperation(HOST_ID),
      }),
      { wrapper: wrapperFor(queryClient) },
    );

    await act(() => result.current.repair.mutateAsync({}));

    expect(result.current.operation).toBeNull();
  });
});

describe("useSandboxSettingsOperation", () => {
  it("is failed when the retry settled with settings not applied, even with the guest configured", async () => {
    requestRequiring.mockResolvedValue({
      guestConfigured: true,
      guestConfigFailureReason: null,
      settingsApplied: false,
    });
    const { result } = renderHook(
      () => ({
        retry: useSandboxRepairGuestConfigurationOnHost(HOST_ID),
        operation: useSandboxSettingsOperation(HOST_ID),
      }),
      { wrapper: wrapperFor(newQueryClient()) },
    );

    await act(() => result.current.retry.mutateAsync({}));

    await waitFor(() => expect(result.current.operation).toBe("failed"));
  });

  it("clears once a later retry applied the settings", async () => {
    requestRequiring.mockResolvedValueOnce({
      guestConfigured: true,
      guestConfigFailureReason: null,
      settingsApplied: false,
    });
    requestRequiring.mockResolvedValueOnce({
      guestConfigured: true,
      guestConfigFailureReason: null,
      settingsApplied: true,
    });
    const { result } = renderHook(
      () => ({
        retry: useSandboxRepairGuestConfigurationOnHost(HOST_ID),
        operation: useSandboxSettingsOperation(HOST_ID),
      }),
      { wrapper: wrapperFor(newQueryClient()) },
    );

    await act(() => result.current.retry.mutateAsync({}));
    await act(() => result.current.retry.mutateAsync({}));

    await waitFor(() => expect(result.current.operation).toBeNull());
  });
});
