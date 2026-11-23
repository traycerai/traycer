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
  it("ends at the confirmation's ceiling while the registry read it waits on is still held", async () => {
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
        if (reads === 1)
          return Promise.resolve({ kind: "hosts", entries: [] });
        // Every later read is held and never answers.
        return new Promise<RemoteHostFetchOutcome>(() => undefined);
      },
    });
    directories.push(directory);
    await directory.start();
    __setBrowserDocumentHiddenForTests(true);

    let loopEnded = false;
    const confirmation = confirmRowWithin(
      (stillWaiting) =>
        directory.catchUpAfterHidden(stillWaiting).then(() => {
          loopEnded = true;
        }),
      { current: () => true },
    );
    // The loop has started the one read it waits on, and holds.
    await vi.waitFor(() => expect(reads).toBe(2));
    expect(loopEnded).toBe(false);

    await vi.advanceTimersByTimeAsync(ROW_CONFIRM_CEILING_MS);
    await confirmation;

    expect(reads).toBe(2);
    expect(loopEnded).toBe(true);
  });
});
