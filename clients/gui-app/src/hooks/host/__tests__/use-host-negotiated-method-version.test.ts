import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import {
  recordNegotiatedHostManifest,
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  useHostNegotiatedMethodVersion,
  useHostNegotiatedMethodVersions,
} from "@/hooks/host/use-host-negotiated-method-version";

/**
 * Pins the tri-state contract fixed by the A2 fixup: `null` for "not yet
 * negotiated" must not collapse into `false` for "negotiated but absent",
 * mirroring `useHostMethodSupport`'s precedent.
 */
describe("useHostNegotiatedMethodVersion", () => {
  afterEach(() => {
    cleanup();
    resetNegotiatedManifests();
  });

  function buildClient(): HostClient<HostRpcRegistry> {
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: { invalidateHostScope: () => {} },
      messenger,
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    });
    // `bind()` died with the active slot (D17): address via a requester.
    const client = spine.createRequester(mockLocalHostEntry);
    client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );
    return client;
  }

  it("reads null when there is no client", () => {
    const { result } = renderHook(() =>
      useHostNegotiatedMethodVersion(null, "epic.createChat"),
    );
    expect(result.current).toBeNull();
  });

  it("reads null when the bound host has not completed a handshake", () => {
    const client = buildClient();
    const { result } = renderHook(() =>
      useHostNegotiatedMethodVersion(client, "epic.createChat"),
    );
    expect(result.current).toBeNull();
  });

  it("reads false when the host negotiated but does not advertise the method", () => {
    const client = buildClient();
    recordNegotiatedHostManifest(mockLocalHostEntry.hostId, {
      "epic.listChats": { major: 1, minor: 0 },
    });

    const { result } = renderHook(() =>
      useHostNegotiatedMethodVersion(client, "epic.createChat"),
    );
    expect(result.current).toBe(false);
  });

  it("reads the exact negotiated version when the host advertises the method", () => {
    const client = buildClient();
    recordNegotiatedHostManifest(mockLocalHostEntry.hostId, {
      "epic.createChat": { major: 2, minor: 3 },
    });

    const { result } = renderHook(() =>
      useHostNegotiatedMethodVersion(client, "epic.createChat"),
    );
    expect(result.current).toEqual({ major: 2, minor: 3 });
  });

  /**
   * Cold-review finding 3: a fresh legacy (name-only) recording of a PRESENT
   * method must not read as `false` ("negotiated absent") - the method is
   * present, only its version is unknown, which stays `null`.
   */
  it("reads null, not false, for a method present only in a legacy name-only recording", () => {
    const client = buildClient();
    recordNegotiatedHostMethods(mockLocalHostEntry.hostId, ["epic.createChat"]);

    const { result } = renderHook(() =>
      useHostNegotiatedMethodVersion(client, "epic.createChat"),
    );
    expect(result.current).toBeNull();
  });

  /**
   * Cold-review finding 3, second ablation: a full-manifest version must not
   * outlive a later legacy name-only recording for the same host. Once the
   * name-only writer has run, the stale `{major, minor}` must not resurface -
   * the read stays `null` (present, version unknown), not the old version.
   */
  it("reads null, not the old version, when a legacy recording supersedes a full manifest", () => {
    const client = buildClient();
    recordNegotiatedHostManifest(mockLocalHostEntry.hostId, {
      "epic.createChat": { major: 2, minor: 3 },
    });
    recordNegotiatedHostMethods(mockLocalHostEntry.hostId, ["epic.createChat"]);

    const { result } = renderHook(() =>
      useHostNegotiatedMethodVersion(client, "epic.createChat"),
    );
    expect(result.current).toBeNull();
  });
});

describe("useHostNegotiatedMethodVersions", () => {
  const HOST_UNKNOWN = "host-unknown";
  const HOST_ABSENT = "host-absent";
  const HOST_READY = "host-ready";
  const HOST_IDS = [HOST_UNKNOWN, HOST_ABSENT, HOST_READY] as const;

  afterEach(() => {
    cleanup();
    resetNegotiatedManifests();
  });

  it("separates unknown, negotiated-absent, and versioned hosts in one map", () => {
    recordNegotiatedHostManifest(HOST_ABSENT, {
      "epic.listChats": { major: 1, minor: 0 },
    });
    recordNegotiatedHostManifest(HOST_READY, {
      "epic.createChat": { major: 1, minor: 2 },
    });

    const { result } = renderHook(() =>
      useHostNegotiatedMethodVersions(HOST_IDS, "epic.createChat"),
    );

    expect(result.current.get(HOST_UNKNOWN)).toBeNull();
    expect(result.current.get(HOST_ABSENT)).toBe(false);
    expect(result.current.get(HOST_READY)).toEqual({ major: 1, minor: 2 });
  });

  it("returns a referentially stable map when nothing changed", () => {
    recordNegotiatedHostManifest(HOST_READY, {
      "epic.createChat": { major: 1, minor: 2 },
    });

    const { result, rerender } = renderHook(() =>
      useHostNegotiatedMethodVersions(HOST_IDS, "epic.createChat"),
    );
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
