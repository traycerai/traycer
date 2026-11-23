import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { RemoteHostFetchOutcome } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  confirmRowWithin,
  ROW_CONFIRM_CEILING_MS,
} from "@traycer-clients/shared/host-transport/row-confirmation";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import {
  __resetDocumentVisibilitySubscribersForTests,
  __setBrowserDocumentHiddenForTests,
} from "@/lib/dom/document-visibility";

const USER_ID = "confirmation-loop-user";

const directories: HostDirectoryService[] = [];

/** The resolvers the directory holds for a confirmation's loop waiting on a read event. */
function readEventWaiters(directory: HostDirectoryService): number {
  const waiters: unknown = Reflect.get(directory, "readEventWaiters");
  if (!Array.isArray(waiters))
    throw new Error("the directory keeps no read-event waiter list");
  return waiters.length;
}

/** A started directory whose every read after its first is held and never answers. */
async function directoryHoldingEveryLaterRead(): Promise<{
  readonly directory: HostDirectoryService;
  readonly reads: () => number;
}> {
  const host = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  let reads = 0;
  const directory = new HostDirectoryService({
    authContextId: () => USER_ID,
    credentialGeneration: null,
    runnerHost: host,
    localHostIdSeeder: null,
    onRegistryPollTick: null,
    remoteFetcher: () => {
      reads += 1;
      if (reads === 1) return Promise.resolve({ kind: "hosts", entries: [] });
      return new Promise<RemoteHostFetchOutcome>(() => undefined);
    },
  });
  directories.push(directory);
  await directory.start();
  __setBrowserDocumentHiddenForTests(true);
  return { directory, reads: () => reads };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const directory of directories.splice(0)) directory.dispose();
  vi.useRealTimers();
  __setBrowserDocumentHiddenForTests(false);
  __resetDocumentVisibilitySubscribersForTests();
});

describe("a row confirmation's loop in the host directory", () => {
  it("ends at the confirmation's ceiling while the registry read it waits on is still held, and leaves no waiter", async () => {
    const { directory, reads } = await directoryHoldingEveryLaterRead();

    let loopEnded = false;
    const confirmation = confirmRowWithin(
      (stillWaiting) =>
        directory.catchUpAfterHidden(stillWaiting).then(() => {
          loopEnded = true;
        }),
      { current: () => true },
    );
    // The loop has started the one read it waits on, and holds.
    await vi.waitFor(() => expect(reads()).toBe(2));
    expect(loopEnded).toBe(false);
    expect(readEventWaiters(directory)).toBe(1);

    await vi.advanceTimersByTimeAsync(ROW_CONFIRM_CEILING_MS);
    await confirmation;

    expect(reads()).toBe(2);
    expect(loopEnded).toBe(true);
    expect(readEventWaiters(directory)).toBe(0);
  });

  it("leaves no suspended loop and no waiter after several confirmations each reach their ceiling against one held read", async () => {
    const { directory, reads } = await directoryHoldingEveryLaterRead();

    let loopsEnded = 0;
    const confirm = (): Promise<void> =>
      confirmRowWithin(
        (stillWaiting) =>
          directory.catchUpAfterHidden(stillWaiting).then(() => {
            loopsEnded += 1;
          }),
        { current: () => true },
      );
    for (let round = 1; round <= 3; round += 1) {
      const confirmation = confirm();
      await vi.advanceTimersByTimeAsync(ROW_CONFIRM_CEILING_MS);
      await confirmation;
    }

    expect(reads()).toBe(2);
    expect(loopsEnded).toBe(3);
    expect(readEventWaiters(directory)).toBe(0);
  });
});
