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

const retry = vi.fn();

function useCombined(input: {
  readonly hostId: string;
  readonly epicId: string;
  readonly fatalCloseCode: string | null;
  readonly snapshotLoaded: boolean;
  readonly isLiveSession: boolean;
}): boolean {
  useRecordHostOlderThanDataRefusal({
    hostId: input.hostId,
    epicId: input.epicId,
    hostVersion: directoryState.version,
    fatalCloseCode: input.fatalCloseCode,
    snapshotLoaded: input.snapshotLoaded,
    isLiveSession: input.isLiveSession,
    retry,
  });
  return useHostRefusesEpicStore(input.hostId, input.epicId);
}

beforeEach(() => {
  resetHostOlderThanDataRefusalsForTests();
  directoryState.version = "1.0.0";
  retry.mockClear();
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
        isLiveSession: true,
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
        isLiveSession: true,
      }),
    );

    // Nothing to wait ON here - the assertion is that no record happened.
    // The reader is read synchronously after the effect has had a chance to
    // run via renderHook's implicit act().
    expect(result.current).toBe(false);
  });

  it("records the refusal even though a snapshot had loaded before the host closed", async () => {
    // The session store keeps `snapshotLoaded` through a close, so a chat
    // that was served and then refused by a host moved to an older build
    // shows both at once. The close is the later fact and must win.
    const { result } = renderHook(() =>
      useCombined({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        fatalCloseCode: HOST_OLDER_THAN_DATA_FATAL_CODE,
        snapshotLoaded: true,
        isLiveSession: true,
      }),
    );

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it("asks the host again, rather than re-recording, when the version moves under a recorded close", async () => {
    const { result, rerender } = renderHook(() =>
      useCombined({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        fatalCloseCode: HOST_OLDER_THAN_DATA_FATAL_CODE,
        snapshotLoaded: false,
        isLiveSession: true,
      }),
    );
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
    expect(retry).not.toHaveBeenCalled();

    // The directory's version moved while the tile still shows the close.
    // Whether the host was upgraded in place (the record must retire) or
    // merely restarted into the same refusing build with the row transiting
    // through the move (the record must survive) cannot be told from here.
    // The effect must not guess either way: no blind re-record against the
    // new version, and one retry so the host's next answer decides.
    directoryState.version = "2.0.0";
    rerender();

    expect(result.current).toBe(false);
    expect(retry).toHaveBeenCalledTimes(1);

    // Re-rendering on the same version asks nothing more.
    rerender();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("re-records against the current version when the retry draws a fresh close", async () => {
    let fatalCloseCode: string | null = HOST_OLDER_THAN_DATA_FATAL_CODE;
    const { result, rerender } = renderHook(() =>
      useCombined({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        fatalCloseCode,
        snapshotLoaded: false,
        isLiveSession: true,
      }),
    );
    await waitFor(() => {
      expect(result.current).toBe(true);
    });

    // The host restarted into the build that refused: the row dropped and
    // came back, the retry cleared the close, and the host closed again.
    directoryState.version = null;
    rerender();
    expect(retry).toHaveBeenCalledTimes(1);
    fatalCloseCode = null;
    rerender();
    directoryState.version = "1.0.0";
    fatalCloseCode = HOST_OLDER_THAN_DATA_FATAL_CODE;
    rerender();

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it("does not clear a sibling's refusal on a version move under a snapshot that merely stayed loaded", async () => {
    // A second tile in the same epic that loaded before the host moved
    // builds and was never closed: its snapshot is still showing, but that
    // is not the host proving it reads the file NOW.
    const { result, rerender } = renderHook(() =>
      useCombined({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        fatalCloseCode: null,
        snapshotLoaded: true,
        isLiveSession: true,
      }),
    );
    expect(result.current).toBe(false);

    // The refused sibling records against the version now current...
    directoryState.version = "2.0.0";
    recordHostOlderThanDataRefusal({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      hostVersion: "2.0.0",
      now: 2,
    });
    await waitFor(() => {
      expect(result.current).toBe(true);
    });

    // ...and this tile's effect re-running on the version move must not
    // erase it on the strength of a snapshot that landed before the move.
    rerender();
    expect(result.current).toBe(true);
    expect(retry).not.toHaveBeenCalled();
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
        isLiveSession: true,
      }),
    );

    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  it("does not clear a refusal recorded beforehand when the surface is a published copy", () => {
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
        isLiveSession: false,
      }),
    );

    expect(result.current).toBe(true);
  });

  it("does not record a refusal from a fatal close on a published copy", () => {
    const { result } = renderHook(() =>
      useCombined({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        fatalCloseCode: HOST_OLDER_THAN_DATA_FATAL_CODE,
        snapshotLoaded: false,
        isLiveSession: false,
      }),
    );

    expect(result.current).toBe(false);
  });
});
