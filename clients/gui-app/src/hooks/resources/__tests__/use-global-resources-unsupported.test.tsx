import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { ResourcesStreamCallbacks } from "@traycer-clients/shared/host-transport/resources-stream-client";
import { createResourcesStore } from "@/stores/resources/resources-store";
import { resourcesRegistry } from "@/stores/resources/resources-registry";
import { useGlobalResourcesUnsupported } from "@/hooks/resources/use-global-resources-unsupported";

// The pre-check's two inputs, and nothing else. Everything downstream of them -
// the registry, the store, the verdict plumbing - runs for real, because the
// composition of the two sources is the entire subject here.
const streamMock = vi.hoisted(() => ({
  support: null as StreamMethodSupport | null,
  version: null as SchemaVersion | null,
}));

vi.mock("@/lib/host/stream-runtime-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/host/stream-runtime-context")>();
  return {
    ...actual,
    useStreamMethodSupport: () => streamMock.support,
    useStreamMethodSchemaVersion: () => streamMock.version,
  };
});

/**
 * Exactly what `RemoteStreamClient` reports for every method, by design:
 * `"unknown"` support and no client-wide schema version. This is the shape that
 * makes the pre-check unable to answer.
 */
function pretendRemoteHost(): void {
  streamMock.support = "unknown";
  streamMock.version = null;
}

/** Opens a real global entry for `hostId` and publishes `verdict` through it. */
function openGlobalStream(
  hostId: string,
  verdict: "supported" | "unsupported",
): void {
  let captured: ResourcesStreamCallbacks | null = null;
  const emit = (): ResourcesStreamCallbacks => {
    if (captured === null) throw new Error("stream callbacks not wired");
    return captured;
  };
  resourcesRegistry.acquireGlobal("token", hostId, () =>
    createResourcesStore({
      scope: { kind: "global" },
      streamClientFactory: (_scope, callbacks) => {
        captured = callbacks;
        return { close: () => undefined };
      },
    }),
  );
  emit().onScopeSupport(verdict);
}

describe("useGlobalResourcesUnsupported", () => {
  afterEach(() => {
    resourcesRegistry.disposeAll();
    streamMock.support = null;
    streamMock.version = null;
  });

  // The gap this hook's second source exists to close, stated as a fact about
  // the first one: on a remote host the pre-check has nothing to convict with,
  // so on its own it clears every host it can never actually see.
  it("is not convicted by the pre-check alone on a remote host", () => {
    pretendRemoteHost();

    const { result } = renderHook(() =>
      useGlobalResourcesUnsupported("host-a"),
    );

    expect(result.current).toBe(false);
  });

  it("convicts a remote host from the verdict its own stream produced", () => {
    pretendRemoteHost();
    openGlobalStream("host-a", "unsupported");

    const { result } = renderHook(() =>
      useGlobalResourcesUnsupported("host-a"),
    );

    expect(result.current).toBe(true);
  });

  // The verdict is about one machine. Reading it for another is how a swap
  // still in flight would print the notice under the wrong host's name.
  it("does not carry one host's verdict onto another", () => {
    pretendRemoteHost();
    openGlobalStream("host-a", "unsupported");

    const { result } = renderHook(() =>
      useGlobalResourcesUnsupported("host-b"),
    );

    expect(result.current).toBe(false);
  });

  it("leaves a remote host cleared when its stream negotiated a global-capable version", () => {
    pretendRemoteHost();
    openGlobalStream("host-a", "supported");

    const { result } = renderHook(() =>
      useGlobalResourcesUnsupported("host-a"),
    );

    expect(result.current).toBe(false);
  });

  // The local path is unchanged and must stay that way: it convicts BEFORE any
  // stream exists, which is what lets the mount decline to acquire at all.
  it("still convicts a local host from the pre-check with no stream open", () => {
    streamMock.support = "supported";
    streamMock.version = { major: 1, minor: 0 };

    const { result } = renderHook(() =>
      useGlobalResourcesUnsupported("host-a"),
    );

    expect(result.current).toBe(true);
  });
});
