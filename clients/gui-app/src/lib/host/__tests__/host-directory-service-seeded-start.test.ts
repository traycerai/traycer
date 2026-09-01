import { afterEach, describe, expect, it } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import type {
  RemoteHostFetchOutcome,
  RemoteHostFetcher,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  HostDirectoryService,
  type HostDirectoryServiceOptions,
} from "@/lib/host/host-directory-service";
import { lastLocalHostIdKey } from "@/lib/persist";

/**
 * `startSeeded()` pins - the split `host-directory-service.ts` introduced so
 * boot does not `await` a `GET /api/v3/hosts` round trip. `start()` keeps its
 * existing contract and existing 75 passing tests in the sibling file
 * untouched; this file exists so the NEW resolve-before-the-registry-answers
 * behaviour has its own coverage rather than none.
 */

const LAST_LOCAL_HOST_ID_STORAGE_KEY = lastLocalHostIdKey();

const localSnapshot: LocalHostSnapshot = {
  hostId: "desktop-pid-123",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "hardiks-macbook",
  displayName: "hardiks-macbook",
  availability: "available",
};

function makeHost(localHost: LocalHostSnapshot | null): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

const directories: HostDirectoryService[] = [];

function makeDirectory(
  options: Omit<HostDirectoryServiceOptions, "onRegistryPollTick"> &
    Partial<Pick<HostDirectoryServiceOptions, "onRegistryPollTick">>,
): HostDirectoryService {
  const directory = new HostDirectoryService({
    onRegistryPollTick: null,
    ...options,
  });
  directories.push(directory);
  return directory;
}

/** A `RemoteHostFetchOutcome` promise the test settles by hand - or never does. */
function deferredOutcome(): {
  readonly promise: Promise<RemoteHostFetchOutcome>;
  readonly settle: (outcome: RemoteHostFetchOutcome) => void;
} {
  let resolveOutcome: (outcome: RemoteHostFetchOutcome) => void = () =>
    undefined;
  const promise = new Promise<RemoteHostFetchOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  return { promise, settle: (outcome) => resolveOutcome(outcome) };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    directory.dispose();
  }
  window.localStorage.removeItem(LAST_LOCAL_HOST_ID_STORAGE_KEY);
});

describe("HostDirectoryService.startSeeded", () => {
  it("resolves before the registry answers - a never-settling fetcher does not block it, and the local entry is already populated", async () => {
    const host = makeHost(localSnapshot);
    const never = deferredOutcome();
    const fetcher: RemoteHostFetcher = () => never.promise;
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });

    await directory.startSeeded();

    expect(directory.getLocalEntry()).not.toBeNull();
    expect(directory.getLocalEntry()?.hostId).toBe(localSnapshot.hostId);
  });

  it("reports the pre-answer window as unknown, not zero - a relay-only shell must not be told to go connect a host during it", async () => {
    const host = makeHost(null);
    const never = deferredOutcome();
    const fetcher: RemoteHostFetcher = () => never.promise;
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });

    await directory.startSeeded();

    expect(directory.getCardinality()).toBe("unknown");
    expect(directory.hasSettledFleet()).toBe(false);
  });

  it("emits the unknown -> zero crossing even though an empty directory is byte-identical either side of it", async () => {
    const host = makeHost(null);
    const deferred = deferredOutcome();
    const fetcher: RemoteHostFetcher = () => deferred.promise;
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });

    await directory.startSeeded();
    expect(directory.getCardinality()).toBe("unknown");

    let notifications = 0;
    directory.onChange(() => {
      notifications += 1;
    });

    deferred.settle({ kind: "hosts", entries: [] });
    // Let the not-awaited `refresh()` this started land - a macrotask flush
    // rather than a fixed count of microtask hops, since `performRefresh`
    // awaits more than one thing after the fetch settles (the local-host
    // reseed included).
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(notifications).toBe(1);
    expect(directory.getCardinality()).toBe("zero");
  });

  // There is deliberately NO pin here for "a rejecting fetch cannot fail
  // boot". It was written, and it could not be made to fail: `fetchRemoteOutcome`
  // already collapses every fetcher rejection into `{ kind: "failed" }`, and
  // `startSeeded()`'s promise is not derived from the void-fired `refresh()`
  // at all, so the property holds by construction rather than by the `.catch`
  // that appears to provide it. Removing that `.catch`, and then also removing
  // `fetchRemoteOutcome`'s own, left it green both times - and this repo's
  // harness sets `dangerouslyIgnoreUnhandledErrors`, so an unhandled rejection
  // could not have failed the run either. A test that cannot redden under any
  // ablation of the code it names is a green line that reads as coverage, so
  // it was deleted rather than kept. What the property really rests on is the
  // `void`, which pin 1 above already ablates.

  it("start()'s contract is intact and costs exactly one fetch - the awaited refresh() joins the one startSeeded() already issued", async () => {
    const host = makeHost(localSnapshot);
    let calls = 0;
    const fetcher: RemoteHostFetcher = () => {
      calls += 1;
      // A macrotask-delayed resolution, deliberately: a synchronously
      // resolving fetcher can settle its background `refresh()` in the same
      // microtask batch `startSeeded()`'s own internal awaits drain, which
      // would let `hasSettledFleet()` read `true` by coincidence even if
      // `start()` never awaited it at all. Only a genuine `await
      // this.refresh()` inside `start()` can wait out a macrotask.
      return new Promise((resolve) => {
        setTimeout(() => resolve({ kind: "hosts", entries: [] }), 0);
      });
    };
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });

    await directory.start();

    expect(directory.hasSettledFleet()).toBe(true);
    expect(calls).toBe(1);
  });
});
