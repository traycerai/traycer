import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectionSubscription } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { AuthorityLog } from "@traycer-clients/shared/host-selection/selection-authority-engine";
import type { HostListFetchResult } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { FakeStreamClient } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type { IpcHostLifecycle } from "../../ipc/runner-ipc-bridge";
import type { DesktopPublishedHostSnapshot } from "../../../ipc-contracts/host-types";
import { DesktopAuthSession } from "../../auth/desktop-auth-session";
import { DesktopHostFleetSource } from "../desktop-selection-ports";
import { startLocalHostInventorySubscription } from "../local-host-inventory-subscription";
import {
  registerRegisteredHostsBroadcast,
  type RegisteredHostsBroadcastBridge,
} from "../../ipc/registered-hosts-broadcast";

// The build that ships without team hosts and sandboxes. Its registry has one
// scope, the personal one, and the local host's push carries all of it - so
// the cadence stands down while the push is healthy and a host that serves
// only @1.0 of the method is a first-class pusher, both as in the release
// before those features.
vi.mock("../../../unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

const silentLog: AuthorityLog = {
  debug: () => undefined,
  warn: () => undefined,
};

class FakeHostLifecycle extends EventEmitter implements IpcHostLifecycle {
  pidMetadataFile = "/tmp/registry-push-coverage-off-test/pid.json";
  identityEnrollmentFile =
    "/tmp/registry-push-coverage-off-test/enrollment.json";
  isDisposed = false;

  getSnapshot(): DesktopPublishedHostSnapshot | null {
    return null;
  }
  notifyRespawning(): void {}
  noteEndpointAnswered(): void {}
  ensureWatcherInstalled(): void {}
  async reloadSnapshotFromDisk(): Promise<DesktopPublishedHostSnapshot | null> {
    return null;
  }
  async getRecentLogTail(_maxLines: number): Promise<string | null> {
    return null;
  }
}

function buildHostListItem(hostId: string): HostListItem {
  return {
    hostId,
    displayName: null,
    platform: null,
    kind: "personal",
    publicKey: "pub-key",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
    updatePolicy: "manual",
  };
}

const tempDirs: string[] = [];

async function writeEnrollment(hostId: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "registry-push-coverage-off-"));
  tempDirs.push(dir);
  const file = join(dir, "enrollment.json");
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ hostId }), "utf8");
  return file;
}

/**
 * The real subscription feeding the real fleet source with the real 60 s
 * cadence beside it, wired as `selection-authority-ipc.ts` wires them - the
 * coverage callback included, which is the leg this build's cadence reads.
 * Only `setInterval` is faked, so the enrollment read and the adopt path run
 * on real I/O.
 */
async function wired(registry: readonly HostListItem[]) {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const authSession = new DesktopAuthSession();
  authSession.setVerified(
    {
      status: "signed-in",
      token: "token-1",
      profile: {
        userId: "user-a",
        userName: "user-a",
        email: "user-a@example.test",
      },
    },
    authSession.beginSet(),
  );
  const identity = {
    current: () => ({ identityKey: "user-a", generation: 0 }),
    onChanged: (): SelectionSubscription => ({ dispose: () => undefined }),
  };
  const host = new FakeHostLifecycle();
  host.identityEnrollmentFile = await writeEnrollment("local-host");
  let bearerReads = 0;
  const fleet = new DesktopHostFleetSource({
    authnBaseUrl: "http://localhost:5005",
    identity,
    authSession,
    host,
    listRegisteredHosts: async (): Promise<HostListFetchResult> => {
      bearerReads += 1;
      return { kind: "ok", response: { hosts: [...registry] } };
    },
    // What the windows are handed is `desktop-selection-ports.test.ts`'s
    // subject; here the fleet snapshot is what the two arms read.
    publishRegistryResponse: () => undefined,
    now: () => 1_000,
    log: silentLog,
  });

  const coverage: boolean[] = [];
  const streamClient = new FakeStreamClient(true);
  const subscription = startLocalHostInventorySubscription({
    localHost: () => ({ hostId: "local-host", websocketUrl: "ws://local" }),
    onLocalHostChanged: () => () => undefined,
    identity: () => ({ userId: "user-a", generation: 0 }),
    onAuthChanged: () => () => undefined,
    openStreamClient: () => streamClient,
    onRows: (read) => {
      void fleet.acceptPushedRows(read);
    },
    onPushActiveChanged: (active) => {
      fleet.setPushActive(active);
      coverage.push(active);
    },
    log: silentLog,
  });
  const bridge: RegisteredHostsBroadcastBridge = {
    disposeFns: [],
    fanOut: () => undefined,
  };
  registerRegisteredHostsBroadcast(bridge, fleet);
  const session = streamClient.sessions[0];
  if (session === undefined) throw new Error("no session opened");

  return {
    fleet,
    coverage,
    bearerReads: () => bearerReads,
    /** One healthy snapshot from the local host, at the negotiated version. */
    push: (hosts: readonly HostListItem[], minor: number): void => {
      session.negotiatedSchemaVersion = { major: 1, minor };
      session.emit(
        {
          kind: "snapshot",
          hasBinaryPayload: false,
          hosts: [...hosts],
          fetchedAtMs: 2_000,
          stale: false,
        },
        null,
      );
    },
    /** One 60 s tick of the cadence; its refresh runs on real I/O. */
    tick: async (): Promise<void> => {
      vi.advanceTimersByTime(60_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    dispose: () => {
      for (const dispose of bridge.disposeFns) dispose();
      subscription.dispose();
      fleet.dispose();
    },
  };
}

afterEach(() => {
  tempDirs.length = 0;
  vi.useRealTimers();
});

describe("the registry cadence without team hosts", () => {
  it("stands down while the local host's push covers the registry", async () => {
    const app = await wired([buildHostListItem("local-host")]);
    // Before any push the tick is the only reader, so the arm below is not
    // green by having no cadence at all.
    await app.tick();
    const readsBeforePush = app.bearerReads();
    expect(readsBeforePush).toBeGreaterThan(0);

    app.push([buildHostListItem("local-host")], 1);
    await vi.waitFor(() => {
      expect(app.coverage.at(-1)).toBe(true);
    });
    await app.tick();

    expect(app.bearerReads()).toBe(readsBeforePush);
    app.dispose();
  });
});

describe("the local-host push without sandboxes", () => {
  it("adopts a snapshot from a host that negotiated only @1.0, and counts it as coverage", async () => {
    const app = await wired([buildHostListItem("local-host")]);

    app.push(
      [buildHostListItem("local-host"), buildHostListItem("second-host")],
      0,
    );

    await vi.waitFor(() => {
      expect(
        app.fleet
          .snapshot()
          .hosts.map((entry) => entry.hostId)
          .sort(),
      ).toEqual(["local-host", "second-host"]);
    });
    expect(app.coverage.at(-1)).toBe(true);
    app.dispose();
  });

  it("adopts no sandbox row from a push negotiated at @1.1", async () => {
    const app = await wired([buildHostListItem("local-host")]);

    app.push(
      [
        buildHostListItem("local-host"),
        { ...buildHostListItem("sandbox-host"), kind: "sandbox" },
      ],
      1,
    );

    // The push is adopted (it arms coverage), but only its personal row
    // reaches the fleet; a build with sandboxes lists both.
    await vi.waitFor(() => {
      expect(app.coverage.at(-1)).toBe(true);
      expect(app.fleet.snapshot().hosts.map((entry) => entry.hostId)).toEqual([
        "local-host",
      ]);
    });
    app.dispose();
  });
});
