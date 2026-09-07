import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";
import type { RegisteredHostsPush } from "../../../ipc-contracts/host-types";
import type { AuthorityIdentitySource } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { AuthorityLog } from "@traycer-clients/shared/host-selection/selection-authority-engine";
import type { HostListFetchResult } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { IpcHostLifecycle } from "../runner-ipc-bridge";
import { DesktopAuthSession } from "../../auth/desktop-auth-session";
import { DesktopHostFleetSource } from "../../selection/desktop-selection-ports";
import {
  createRegisteredHostsPublisher,
  registerRegisteredHostsBroadcast,
  type RegisteredHostsBroadcastBridge,
} from "../registered-hosts-broadcast";

const silentLog: AuthorityLog = {
  debug: () => undefined,
  warn: () => undefined,
};

const identity: AuthorityIdentitySource = {
  current: () => ({ identityKey: null, generation: 0 }),
  onChanged: () => ({ dispose: () => undefined }),
};

const host: IpcHostLifecycle = {
  getSnapshot: () => null,
  on: () => undefined,
  off: () => undefined,
  notifyRespawning: () => undefined,
  pidMetadataFile: "/tmp/registered-hosts-broadcast-test/pid.json",
  identityEnrollmentFile:
    "/tmp/registered-hosts-broadcast-test/enrollment.json",
  isDisposed: false,
  reloadSnapshotFromDisk: async () => null,
  noteEndpointAnswered: () => undefined,
  ensureWatcherInstalled: () => undefined,
  getRecentLogTail: async () => null,
};

/** `DesktopHostFleetSource` is a concrete class with private members, so it cannot be faked structurally the way the bridge below is. */
function buildFleet(): DesktopHostFleetSource {
  return new DesktopHostFleetSource({
    authnBaseUrl: "http://localhost:5005",
    identity,
    authSession: new DesktopAuthSession(),
    host,
    listRegisteredHosts: async (): Promise<HostListFetchResult> => {
      throw new Error(
        "must not be called - registerRegisteredHostsBroadcast only drives refresh(), which every test here stubs",
      );
    },
    publishRegistryResponse: () => undefined,
    log: silentLog,
  });
}

describe("registerRegisteredHostsBroadcast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drives fleet.refresh() on every 60s tick, repeatedly - not just once (a rearm regression must be visible)", async () => {
    const bridge: RegisteredHostsBroadcastBridge = {
      disposeFns: [],
      fanOut: vi.fn(),
    };
    const fleet = buildFleet();
    const refreshSpy = vi.spyOn(fleet, "refresh").mockResolvedValue(undefined);

    registerRegisteredHostsBroadcast(bridge, fleet);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshSpy).toHaveBeenCalledTimes(3);
  });

  it("the disposer stops the interval - dispose, advance, no further refresh() calls", async () => {
    const bridge: RegisteredHostsBroadcastBridge = {
      disposeFns: [],
      fanOut: vi.fn(),
    };
    const fleet = buildFleet();
    const refreshSpy = vi.spyOn(fleet, "refresh").mockResolvedValue(undefined);

    registerRegisteredHostsBroadcast(bridge, fleet);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    expect(bridge.disposeFns).toHaveLength(1);
    for (const dispose of bridge.disposeFns) dispose();

    await vi.advanceTimersByTimeAsync(180_000);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});

describe("createRegisteredHostsPublisher", () => {
  it("fans out the exact push on the registeredHostsChange channel through bridge.fanOut - the app-wide broadcast primitive", () => {
    const fanOut = vi.fn();
    const bridge: RegisteredHostsBroadcastBridge = {
      disposeFns: [],
      fanOut,
    };
    const publish = createRegisteredHostsPublisher(bridge);
    const push: RegisteredHostsPush = {
      identityKey: "user-a",
      response: { hosts: [] },
    };

    publish(push);

    expect(fanOut).toHaveBeenCalledTimes(1);
    expect(fanOut).toHaveBeenCalledWith(
      RunnerHostEvent.registeredHostsChange,
      push,
    );
  });
});
