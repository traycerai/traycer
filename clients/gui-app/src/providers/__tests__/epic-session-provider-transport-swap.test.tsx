import "../../../__tests__/test-browser-apis";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

const hostState = vi.hoisted(() => ({ id: "host-a" }));
// A host restart hands the renderer a NEW transport under the SAME hostId and
// closes the prior one. Model that with a swappable client identity behind
// `useWsStreamClient`. The values only need distinct identities (the
// `__setEpicStreamClientFactoryForTests` override stands in for the real
// `EpicStreamClient`), so untyped object handles are sufficient here.
const clientHolder = vi.hoisted(() => ({ current: null as object | null }));
const authServiceStub = vi.hoisted(() => ({
  revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
}));
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => clientHolder.current,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => hostState.id,
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useAuthService: () => authServiceStub,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

import { EpicSessionProvider } from "@/providers/epic-session-provider";
import {
  __getOpenEpicRegistryForTests,
  __setEpicStreamClientFactoryForTests,
} from "@/lib/registries/epic-session-registry";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { setDesktopEpicOwnershipBridge } from "@/lib/windows/desktop-epic-ownership";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

interface ControlledStream {
  closeCount: number;
}

function resetCanvasStore(): void {
  useEpicCanvasStore.setState({
    tabsById: {},
    openTabOrder: [],
    activeTabId: null,
    mostRecentTabIdByEpicId: {},
    artifactTreeByEpicId: {},
  });
}

function HandleProbe(props: {
  onHandle: (handle: OpenEpicStoreHandle) => void;
}) {
  const { onHandle } = props;
  const handle = useMaybeOpenEpicHandle();
  useEffect(() => {
    if (handle === null) return;
    onHandle(handle);
  }, [handle, onHandle]);
  return null;
}

describe("<EpicSessionProvider /> transport swap", () => {
  beforeEach(() => {
    window.localStorage.clear();
    hostState.id = "host-a";
    clientHolder.current = {};
    navigateMock.mockClear();
    resetCanvasStore();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
    setDesktopEpicOwnershipBridge(null);
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: "alice@example.com",
        userName: "alice@example.com",
        email: "alice@example.com",
      },
      contextMetadata: {
        userId: "alice@example.com",
        username: "alice@example.com",
      },
    });
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
    setDesktopEpicOwnershipBridge(null);
    resetCanvasStore();
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
  });

  it("re-subscribes the reused session on the new transport after a host restart", async () => {
    const streams: ControlledStream[] = [];
    const seenHandles: OpenEpicStoreHandle[] = [];
    __setEpicStreamClientFactoryForTests((_epicId, _callbacks) => {
      const stream: ControlledStream = { closeCount: 0 };
      streams.push(stream);
      return {
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => {
          stream.closeCount += 1;
        },
      };
    });

    const view = render(
      <EpicSessionProvider epicId="epic-swap" tabId="epic-swap">
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(seenHandles).toHaveLength(1);
    });
    const firstHandle = seenHandles.at(-1);
    expect(streams).toHaveLength(1);

    // Host restart: same hostId, brand-new transport (the old one is closed by
    // the stream provider). The session is keyed on the stable hostId so it is
    // reused - the fix must re-open the stream on the new client rather than
    // leaving it bound to the closed one.
    act(() => {
      clientHolder.current = {};
      view.rerender(
        <EpicSessionProvider epicId="epic-swap" tabId="epic-swap">
          <HandleProbe
            onHandle={(handle) => {
              seenHandles.push(handle);
            }}
          />
        </EpicSessionProvider>,
      );
    });

    await waitFor(() => {
      expect(streams).toHaveLength(2);
    });

    // Same store reused (no identity change), old stream torn down, fresh
    // stream opened on the new transport.
    expect(seenHandles.at(-1)).toBe(firstHandle);
    expect(streams[0].closeCount).toBe(1);
    expect(__getOpenEpicRegistryForTests().size()).toBe(1);
  });

  it("does not re-subscribe when the transport identity is unchanged", async () => {
    const streams: ControlledStream[] = [];
    const seenHandles: OpenEpicStoreHandle[] = [];
    __setEpicStreamClientFactoryForTests((_epicId, _callbacks) => {
      const stream: ControlledStream = { closeCount: 0 };
      streams.push(stream);
      return {
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => {
          stream.closeCount += 1;
        },
      };
    });

    const view = render(
      <EpicSessionProvider epicId="epic-stable" tabId="epic-stable">
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(seenHandles).toHaveLength(1);
    });

    // Re-render with the SAME client identity - a benign re-render must not
    // tear down and re-open the live stream.
    act(() => {
      view.rerender(
        <EpicSessionProvider epicId="epic-stable" tabId="epic-stable">
          <HandleProbe
            onHandle={(handle) => {
              seenHandles.push(handle);
            }}
          />
        </EpicSessionProvider>,
      );
    });

    await Promise.resolve();
    expect(streams).toHaveLength(1);
    expect(streams[0].closeCount).toBe(0);
  });
});
