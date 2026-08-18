import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { HostStreamClientBinding } from "@/hooks/host/use-host-stream-client-for";
import {
  StreamRuntimeContext,
  type StreamRuntimeBinding,
} from "@/lib/host/stream-runtime-context";

/**
 * `useSurfaceHostStreamBinding` pins the three answers the hook's own doc
 * comment names: FOLLOWING re-provides the ambient binding untouched (so a
 * surface following the effective host shares its `git.subscribeStatus`
 * rather than opening a second one - the cache the app-wide `HostStreamProvider`
 * exists to protect); pinned-and-MATCHED re-provides the pinned host's own
 * binding, named with ITS hostId; pinned-and-not-yet-matched is `null` -
 * PENDING, never the ambient value.
 *
 * That last arm is the one this file exists to pin. Before this hook, callers
 * wrote `pinned ?? ambient`, which read the commit after a pin lands or moves -
 * before `useHostStreamClientBindingFor`'s own effect has built or re-keyed its
 * client - as "following", and rode the AMBIENT host's socket carrying the
 * PINNED host's params for one commit on every mount: a git-diff tile pinned to
 * host B dispatched `git.subscribeStatus` for B's path over host A's socket,
 * and A started a watcher on a path that commonly exists on both machines.
 * `null` is the honest state instead - `useWsStreamClient()` reads it as "no
 * client yet" and subscriptions wait.
 */

const refs = vi.hoisted<{
  effective: string | null;
  entry: HostDirectoryEntry | null;
  binding: HostStreamClientBinding | null;
  expectedKey: string | null;
}>(() => ({
  effective: null,
  entry: null,
  binding: null,
  expectedKey: null,
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => refs.effective,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  // The hook passes `null` while following - mirror that gate here so a
  // stray call from the following branch can never read the pinned fixture.
  useHostDirectoryEntryForHostId: (hostId: string | null) =>
    hostId === null ? null : refs.entry,
}));

vi.mock("@/lib/host/stream-auth-revalidator", () => ({
  useStreamAuthRevalidator: () => null,
}));

vi.mock("@/lib/host", () => ({
  // Only this object's IDENTITY matters here - it flows straight into the
  // mocked `authenticatedOwnerIdentityKey` below, which this file also
  // controls, so the real derivation is never exercised.
  useHostClient: () => ({}),
}));

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientBindingFor: () => refs.binding,
  authenticatedOwnerIdentityKey: () => refs.expectedKey,
}));

import { useSurfaceHostStreamBinding } from "@/hooks/host/use-surface-host-stream-binding";

function fakeStreamClient(
  instanceId: string,
): IHostStreamClient<HostStreamRpcRegistry> {
  return {
    subscribe: () => {
      throw new Error("not exercised by this test");
    },
    subscribeWithParamsProvider: () => {
      throw new Error("not exercised by this test");
    },
    close: () => undefined,
    isClosed: () => false,
    notifyBearerRotated: () => undefined,
    reconnectAll: () => undefined,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => undefined,
    getClosedReason: () => null,
    onClosed: () => () => undefined,
    instanceId,
  };
}

const AMBIENT_CLIENT = fakeStreamClient("ambient-client");
const PINNED_CLIENT = fakeStreamClient("pinned-client");

// The value every consumer above `StreamRuntimeContext.Provider` already
// sees - the FOLLOWING arm must hand back this exact object, not an
// equivalent one, so a surface that follows shares the app-wide subscription
// registry's `client.instanceId` key instead of splitting it.
const AMBIENT: StreamRuntimeBinding = {
  wsStreamClient: AMBIENT_CLIENT,
  hostId: "host-a",
};

const HOST_B: HostDirectoryEntry = {
  hostId: "host-b",
  label: "host-b",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:59999/stream",
  version: null,
  transportDialability: "dialable",
};

function wrapper({ children }: { readonly children: ReactNode }): ReactNode {
  return createElement(
    StreamRuntimeContext.Provider,
    { value: AMBIENT },
    children,
  );
}

beforeEach(() => {
  refs.effective = null;
  refs.entry = null;
  refs.binding = null;
  refs.expectedKey = null;
});

afterEach(() => {
  cleanup();
});

describe("useSurfaceHostStreamBinding", () => {
  describe("following - resolvedHostId is null or matches the effective host", () => {
    it("re-provides the AMBIENT binding when the pin resolves TO the effective host", () => {
      // The app-wide `HostStreamProvider` builds its client outside the
      // per-host cache, so a surface that built its own here - even for the
      // host it is already following - would hold a DIFFERENT object than
      // every other app-wide consumer and split one `git.subscribeStatus`
      // into two against the same host.
      refs.effective = "host-a";

      const { result } = renderHook(
        () => useSurfaceHostStreamBinding("host-a"),
        { wrapper },
      );

      expect(result.current).toBe(AMBIENT);
    });

    it("re-provides the AMBIENT binding when the surface has no pin at all", () => {
      refs.effective = "host-a";

      const { result } = renderHook(() => useSurfaceHostStreamBinding(null), {
        wrapper,
      });

      expect(result.current).toBe(AMBIENT);
    });

    it("returns null - not the ambient binding - for the commit after the EFFECTIVE host moves onto the pin, while the ambient binding still names the old host", () => {
      // The surface is pinned to host-b and was serving its own host-b
      // binding; the effective host now moves a -> b, so `isFollowing` flips
      // on this commit - but `HostStreamProvider` replaces its state-held
      // binding in a passive effect, so the ambient value still names host-a.
      // Handing it on would move the surface OFF its correct host-b stream and
      // onto host-a's socket for one commit (git-diff / file-tree subscribe
      // host-b paths over it). Pending is the honest state; the ambient
      // binding is handed on only once it names host-b.
      refs.effective = "host-b";
      refs.entry = HOST_B;
      refs.binding = {
        client: PINNED_CLIENT,
        transportKey: "k1",
        pin: () => undefined,
        unpin: () => undefined,
      };
      refs.expectedKey = "k1";

      const AMBIENT_B: StreamRuntimeBinding = {
        wsStreamClient: AMBIENT_CLIENT,
        hostId: "host-b",
      };
      let ambient: StreamRuntimeBinding = AMBIENT;
      const { result, rerender } = renderHook(
        () => useSurfaceHostStreamBinding("host-b"),
        {
          wrapper: ({ children }) =>
            createElement(
              StreamRuntimeContext.Provider,
              { value: ambient },
              children,
            ),
        },
      );

      expect(result.current).toBeNull();
      expect(result.current).not.toBe(AMBIENT);

      // The provider's effect lands: the ambient binding now names host-b and
      // is the value to share (same object, same subscription registry key).
      ambient = AMBIENT_B;
      rerender();
      expect(result.current).toBe(AMBIENT_B);
    });
  });

  describe("pinned to another host, transport key MATCHED", () => {
    it("returns the pinned host's OWN binding, named with its hostId", () => {
      refs.effective = "host-a";
      refs.entry = HOST_B;
      refs.binding = {
        client: PINNED_CLIENT,
        transportKey: "k1",
        pin: () => undefined,
        unpin: () => undefined,
      };
      refs.expectedKey = "k1";

      const { result } = renderHook(
        () => useSurfaceHostStreamBinding("host-b"),
        { wrapper },
      );

      const value = result.current;
      expect(value).not.toBeNull();
      if (value === null) {
        throw new Error("expected a pinned binding, got null");
      }
      expect(value.wsStreamClient).toBe(PINNED_CLIENT);
      expect(value.hostId).toBe("host-b");
    });
  });

  describe("pinned to another host, transport key NOT yet matched - PENDING", () => {
    it("returns null - not the ambient binding - while the underlying hook has not built a client yet", () => {
      // The underlying hook holds its binding in state and only replaces it
      // in an EFFECT, so for one commit after a pin lands it can still be
      // `null` while `resolvedHostId` has already moved off the ambient host.
      // Folding that into "following" (the old `pinned ?? ambient` shape)
      // would ride host A's socket under host B's name for that commit.
      refs.effective = "host-a";
      refs.entry = HOST_B;
      refs.binding = null;
      refs.expectedKey = "k1";

      const { result } = renderHook(
        () => useSurfaceHostStreamBinding("host-b"),
        { wrapper },
      );

      expect(result.current).toBeNull();
      expect(result.current).not.toBe(AMBIENT);
    });

    it("returns null - not the ambient binding - for the commit after a pin MOVES, before the binding re-keys", () => {
      // A binding can be non-null yet still describe the PREVIOUS host: the
      // transport-key guard is what tells the two apart. A mismatched key
      // means there is no client yet for the CURRENT target, so this must
      // read exactly like the "no binding" arm above, not like "keep serving
      // the stale client".
      refs.effective = "host-a";
      refs.entry = HOST_B;
      refs.binding = {
        client: PINNED_CLIENT,
        transportKey: "k1",
        pin: () => undefined,
        unpin: () => undefined,
      };
      refs.expectedKey = "k2";

      const { result } = renderHook(
        () => useSurfaceHostStreamBinding("host-b"),
        { wrapper },
      );

      expect(result.current).toBeNull();
      expect(result.current).not.toBe(AMBIENT);
    });
  });
});
