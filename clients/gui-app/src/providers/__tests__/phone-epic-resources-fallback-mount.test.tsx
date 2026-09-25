import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type {
  ResourcesProjectionPayload,
  ResourcesStreamCallbacks,
  ResourcesStreamScope,
} from "@traycer-clients/shared/host-transport/resources-stream-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { OwnerResourceSnapshotWireV15 } from "@traycer/protocol/host/resources/subscribe";
import {
  GlobalResourcesStreamMount,
  PhoneEpicResourcesFallbackMount,
} from "@/providers/resources-stream-mount";
import { __setResourcesStreamClientFactoryForTests } from "@/providers/resources-stream-factory-override";
import { resourcesRegistry } from "@/stores/resources/resources-registry";
import { useSettingsStore } from "@/stores/settings/settings-store";

// Defaults are a REMOTE host as the transport reports one: `"unknown"` support
// and no schema version, so the pre-check cannot convict and only the global
// stream's own negotiation can say the host is too old - the case a phone is
// always in. A test flips `version` to model a local host whose capability
// cache convicts it before any stream opens.
const streamMock = vi.hoisted(
  (): {
    version: { readonly major: number; readonly minor: number } | null;
  } => ({
    version: null,
  }),
);

vi.mock("@/lib/host/stream-runtime-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/host/stream-runtime-context")>();
  return {
    ...actual,
    useWsStreamClient: () => fakeStreamClient,
    useStreamHostId: () => "host-1",
    useStreamMethodSupport: () =>
      streamMock.version === null ? "unknown" : "supported",
    useStreamMethodSchemaVersion: () => streamMock.version,
  };
});

const fakeStreamClient: IHostStreamClient<HostStreamRpcRegistry> = {
  subscribe: () => {
    throw new Error("not exercised by this test");
  },
  subscribeWithParamsProvider: () => {
    throw new Error("not exercised by this test");
  },
  close: () => undefined,
  isClosed: () => false,
  isReady: () => false,
  notifyBearerRotated: () => undefined,
  notifyCloudVerdictChanged: () => undefined,
  reconnectAll: () => undefined,
  getMethodSupport: () => "unknown",
  subscribeMethodSupport: () => () => undefined,
  getMethodSchemaVersion: () => null,
  subscribeAvailabilityRecovered: () => () => undefined,
  getClosedReason: () => null,
  onClosed: () => () => undefined,
  instanceId: "fake-phone-fallback-stream-client",
};

/** The live callbacks of each open stream, keyed by what it subscribed to. */
const streams = new Map<string, ResourcesStreamCallbacks>();

function scopeKey(scope: ResourcesStreamScope): string {
  return scope.kind === "global" ? "global" : `epic:${scope.epicId}`;
}

function streamFor(key: string): ResourcesStreamCallbacks {
  const callbacks = streams.get(key);
  if (callbacks === undefined) throw new Error(`no ${key} stream is open`);
  return callbacks;
}

function owner(): OwnerResourceSnapshotWireV15 {
  return {
    owner: {
      kind: "terminal",
      hostId: "host-1",
      epicId: "epic-1",
      ownerId: "term-1",
    },
    sampledAt: 1_000,
    rootPids: [1],
    harnessId: null,
    managedCommand: null,
    activeProcessName: "bash",
    processCount: 1,
    cpuPercent: 12,
    rssBytes: 1_000,
    pssBytes: null,
    privateBytes: null,
    processes: [
      {
        pid: 1,
        parentPid: null,
        rootPid: 1,
        name: "bash",
        command: "/bin/bash",
        cpuPercent: 12,
        rssBytes: 1_000,
        pssBytes: null,
        privateBytes: null,
        descriptor: null,
      },
    ],
  };
}

function epicSnapshot(): ResourcesProjectionPayload {
  return {
    epicId: "epic-1",
    sampledAt: 1_000,
    app: null,
    owners: [owner()],
    epic: null,
    epics: [],
    hostTree: undefined,
    other: undefined,
    restricted: undefined,
  };
}

/**
 * The phone with an epic pane mounted and its tab switcher sheet CLOSED: the
 * pane's fallback mount is the only thing that could lease the epic. The
 * monitor stands for the header panel or an opted-in footer readout.
 */
function PhoneEpicPane(props: { readonly monitorOpen: boolean }) {
  return (
    <>
      {props.monitorOpen ? <GlobalResourcesStreamMount interactive /> : null}
      <PhoneEpicResourcesFallbackMount epicId="epic-1" />
    </>
  );
}

describe("<PhoneEpicResourcesFallbackMount />", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      showGlobalResourceMonitor: true,
      navigatorResourceMetrics: [],
    });
    __setResourcesStreamClientFactoryForTests((scope, callbacks) => {
      streams.set(scopeKey(scope), callbacks);
      return {
        close: () => {
          streams.delete(scopeKey(scope));
        },
        setDemand: () => undefined,
      };
    });
  });

  afterEach(() => {
    cleanup();
    __setResourcesStreamClientFactoryForTests(null);
    resourcesRegistry.disposeAll();
    streams.clear();
    streamMock.version = null;
  });

  it("feeds an old host's global monitor from the pane while the sheet is closed", () => {
    const view = render(<PhoneEpicPane monitorOpen />);
    expect(resourcesRegistry.get("epic-1")).toBeNull();

    // The `@1.0` host accepts the downgraded global probe and its negotiated
    // version convicts it - the remote, stream-only verdict.
    act(() => streamFor("global").onScopeSupport("unsupported"));
    expect(resourcesRegistry.get("epic-1")).not.toBeNull();

    act(() => streamFor("epic:epic-1").onSnapshot(epicSnapshot()));
    const projection = resourcesRegistry.getGlobalProjection();
    expect(projection.hostId).toBe("host-1");
    expect(projection.owners.map((row) => row.owner.ownerId)).toEqual([
      "term-1",
    ]);

    // The monitor closes: nothing on screen reads the fallback any more.
    view.rerender(<PhoneEpicPane monitorOpen={false} />);
    expect(resourcesRegistry.get("epic-1")).toBeNull();
    expect(streams.has("epic:epic-1")).toBe(false);
  });

  it("opens no epic stream for a host that serves the global scope", () => {
    render(<PhoneEpicPane monitorOpen />);

    act(() => streamFor("global").onScopeSupport("supported"));

    expect(resourcesRegistry.get("epic-1")).toBeNull();
    expect(streams.has("epic:epic-1")).toBe(false);
  });

  it("opens no epic stream while no global monitor is up", () => {
    render(<PhoneEpicPane monitorOpen={false} />);

    expect(resourcesRegistry.get("epic-1")).toBeNull();
    expect(streams.size).toBe(0);
  });

  // A host convicted before any stream opens leaves no global entry behind, so
  // the verdict alone cannot tell whether anything on screen wants numbers -
  // the consumer count is what keeps the pane shut until one does.
  it("follows the monitor for a host the pre-check already convicted", () => {
    streamMock.version = { major: 1, minor: 0 };
    const view = render(<PhoneEpicPane monitorOpen={false} />);
    expect(resourcesRegistry.get("epic-1")).toBeNull();

    view.rerender(<PhoneEpicPane monitorOpen />);
    expect(resourcesRegistry.getGlobal()).toBeNull();
    expect(resourcesRegistry.get("epic-1")).not.toBeNull();

    view.rerender(<PhoneEpicPane monitorOpen={false} />);
    expect(resourcesRegistry.get("epic-1")).toBeNull();
  });
});
