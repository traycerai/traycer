import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { HOST_OLDER_THAN_DATA_FATAL_CODE } from "@traycer/protocol/host/store-formats";

const HOST_ID = "host-a";
const EPIC_ID = "epic-1";

const directoryState = vi.hoisted(() => ({
  version: "1.0.0" as string | null,
}));

// The reader takes the host's version off the shared connection registry's
// context-free row read, so that is the seam stubbed here: one row per asked
// host, at a controllable version. The per-host row subscription stays real.
vi.mock(
  "@traycer-clients/shared/host-client/host-connection-registry",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-connection-registry")
      >();
    return {
      ...actual,
      readHostDirectoryEntry: (hostId: string): HostDirectoryEntry | null => ({
        ...mockLocalHostEntry,
        hostId,
        version: directoryState.version,
      }),
    };
  },
);

import {
  recordHostOlderThanDataRefusal,
  resetHostOlderThanDataRefusalsForTests,
} from "@/lib/chats/host-older-than-data-refusals";
import {
  useHostRefusesEpicStore,
  useRecordHostOlderThanDataRefusal,
} from "@/hooks/chats/use-host-refuses-epic-store";

function useCombined(input: {
  readonly hostId: string;
  readonly epicId: string;
  readonly fatalCloseCode: string | null;
  readonly snapshotLoaded: boolean;
}): boolean {
  useRecordHostOlderThanDataRefusal({
    hostId: input.hostId,
    epicId: input.epicId,
    hostVersion: directoryState.version,
    fatalCloseCode: input.fatalCloseCode,
    snapshotLoaded: input.snapshotLoaded,
  });
  return useHostRefusesEpicStore(input.hostId, input.epicId);
}

beforeEach(() => {
  resetHostOlderThanDataRefusalsForTests();
  directoryState.version = "1.0.0";
});

afterEach(() => {
  cleanup();
});

describe("useHostRefusesEpicStore", () => {
  it("is false with nothing recorded", () => {
    const { result } = renderHook(() =>
      useHostRefusesEpicStore(HOST_ID, EPIC_ID),
    );

    expect(result.current).toBe(false);
  });

  it("is false when hostId is null", () => {
    recordHostOlderThanDataRefusal({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      hostVersion: "1.0.0",
      now: 1,
    });

    const { result } = renderHook(() => useHostRefusesEpicStore(null, EPIC_ID));

    expect(result.current).toBe(false);
  });

  it("answers false again once the directory reports a different host version", () => {
    recordHostOlderThanDataRefusal({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      hostVersion: "1.0.0",
      now: 1,
    });

    const { result, rerender } = renderHook(() =>
      useHostRefusesEpicStore(HOST_ID, EPIC_ID),
    );
    expect(result.current).toBe(true);

    directoryState.version = "2.0.0";
    rerender();

    expect(result.current).toBe(false);
  });
});

describe("useRecordHostOlderThanDataRefusal", () => {
  it("records the refusal on a HOST_OLDER_THAN_DATA fatal close, flipping the reader to true", async () => {
    const { result } = renderHook(() =>
      useCombined({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        fatalCloseCode: HOST_OLDER_THAN_DATA_FATAL_CODE,
        snapshotLoaded: false,
      }),
    );

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it("records nothing for a different fatal code", () => {
    const { result } = renderHook(() =>
      useCombined({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        fatalCloseCode: "SOME_OTHER_FATAL_CODE",
        snapshotLoaded: false,
      }),
    );

    // Nothing to wait ON here - the assertion is that no record happened.
    // The reader is read synchronously after the effect has had a chance to
    // run via renderHook's implicit act().
    expect(result.current).toBe(false);
  });

  it("clears an existing refusal once a snapshot lands", async () => {
    recordHostOlderThanDataRefusal({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      hostVersion: "1.0.0",
      now: 1,
    });

    const { result } = renderHook(() =>
      useCombined({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        fatalCloseCode: null,
        snapshotLoaded: true,
      }),
    );

    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });
});
