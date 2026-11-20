/**
 * The owner identity stamped on a session's handle decides what a later
 * admission of a WARM handle means: an absent reading never overwrites a known
 * key, the first real reading completes an unstamped one, and a known key that
 * differs discards the handle. The readings are the host clients the
 * directory resolves for the handle's host.
 *
 * The remote cases use a client over a REMOTE directory entry, whose owner
 * identity includes the host's public key: the same host id under a different
 * key is a key rotation.
 */
import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => null,
}));

import {
  EPIC_ID,
  HOST_ID,
  admittedHandle,
  deliverSnapshot,
  installReaderCardHarness,
  openShownTaskTab,
  seen,
} from "@/components/bots/__tests__/artifact-reader-card-harness-support";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { ESTABLISHING_DEADLINE_MS } from "@/lib/host/bounded-load-budgets";
import { getEpicSessionController } from "@/lib/registries/epic-session-controller";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";

installReaderCardHarness();

afterEach(() => {
  vi.useRealTimers();
});

const OTHER_USER = "user-changed";

function acquire(rowKey: string) {
  const token = getEpicSessionController().acquireArtifactReader({
    hostId: HOST_ID,
    epicId: EPIC_ID,
    rowKey,
  });
  return token;
}

/** A reader built the handle, then let go: the handle is warm, stamped with the reader's owner. */
function warmHandleOf(rowKey: string) {
  const token = acquire(rowKey);
  const handle = admittedHandle();
  token.release();
  expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBe(handle);
  return handle;
}

describe("a warm handle's recorded owner", () => {
  it("is discarded when a later admission reads a different known owner", () => {
    const handle = warmHandleOf("row-1");
    const dispose = vi.spyOn(handle, "dispose");
    const constructionsBefore = seen.constructions;
    seen.clientUser = OTHER_USER;

    acquire("row-2");

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(seen.constructions).toBe(constructionsBefore + 1);
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).not.toBe(handle);
  });

  it("is kept when a later admission has no reading at all", () => {
    const handle = warmHandleOf("row-1");
    const dispose = vi.spyOn(handle, "dispose");
    seen.clientUser = null;

    acquire("row-2");

    expect(dispose).not.toHaveBeenCalled();
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBe(handle);
  });

  it("still remembers its owner across an absent reading, so a changed owner after it discards", () => {
    const handle = warmHandleOf("row-1");
    const dispose = vi.spyOn(handle, "dispose");
    seen.clientUser = null;
    acquire("row-2");
    expect(dispose).not.toHaveBeenCalled();
    seen.clientUser = OTHER_USER;
    const constructionsBefore = seen.constructions;

    acquire("row-3");

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(seen.constructions).toBe(constructionsBefore + 1);
  });

  it("is completed, not discarded, when a handle built with no reading meets its first real one", () => {
    seen.clientUser = null;
    openShownTaskTab();
    const handle = admittedHandle();
    const dispose = vi.spyOn(handle, "dispose");
    const constructionsBefore = seen.constructions;
    seen.clientUser = "user-fixture-1";

    acquire("row-1");

    expect(dispose).not.toHaveBeenCalled();
    expect(seen.constructions).toBe(constructionsBefore);
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBe(handle);
  });
});

describe("a warm handle on a remote host", () => {
  it("is rebuilt when the host's public key rotated under the same id", () => {
    seen.remotePublicKey = "key-before";
    const handle = warmHandleOf("row-1");
    const dispose = vi.spyOn(handle, "dispose");
    const constructionsBefore = seen.constructions;
    seen.remotePublicKey = "key-after";

    acquire("row-2");

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(seen.constructions).toBe(constructionsBefore + 1);
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).not.toBe(handle);
  });

  it("is not admitted again with no owner reading, and is once its own transport proves the owner", async () => {
    seen.remotePublicKey = "key-before";
    const handle = warmHandleOf("row-1");
    seen.clientUser = null;

    const token = acquire("row-2");

    // A retained stamp is history, not proof: no reading, so no ready reader
    // and no rebuild of the handle either.
    expect(token.read().kind).not.toBe("ready");
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBe(handle);

    seen.clientUser = "user-fixture-1";
    deliverSnapshot();

    await waitFor(() => expect(token.read().kind).toBe("ready"));
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBe(handle);
  });

  it("fails an owner that never proves itself at the establishing deadline, builds nothing, and Retry asks again", () => {
    seen.remotePublicKey = "key-before";
    const handle = warmHandleOf("row-1");
    seen.clientUser = null;
    const constructionsBefore = seen.constructions;
    vi.useFakeTimers();
    const token = acquire("row-2");
    expect(token.read().kind).toBe("acquiring");

    vi.advanceTimersByTime(ESTABLISHING_DEADLINE_MS - 1);

    expect(token.read().kind).toBe("acquiring");

    vi.advanceTimersByTime(1);

    // Failed, never admitted: the warm handle is neither shown nor rebuilt.
    expect(token.read().kind).toBe("failed");
    expect(seen.constructions).toBe(constructionsBefore);
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBe(handle);

    token.retry();

    expect(token.read().kind).toBe("acquiring");
    expect(seen.constructions).toBe(constructionsBefore);
  });

  it("is admitted by the next run once its owner can be read, with no Retry, after the deadline had failed it", () => {
    seen.remotePublicKey = "key-before";
    const handle = warmHandleOf("row-1");
    seen.clientUser = null;
    const constructionsBefore = seen.constructions;
    vi.useFakeTimers();
    openShownTaskTab();
    const controller = getEpicSessionController();
    expect(controller.readEntryStatusForTests(EPIC_ID)?.presentation.kind).toBe(
      "establishing",
    );

    vi.advanceTimersByTime(ESTABLISHING_DEADLINE_MS);

    expect(controller.readEntryStatusForTests(EPIC_ID)?.presentation.kind).toBe(
      "failed",
    );

    // The host now supplies its owner, and the warm store's next update wakes
    // the waiting run: the run, not a Retry, admits the handle.
    seen.clientUser = "user-fixture-1";
    act(() => {
      handle.store.setState((state) => ({ ...state }));
    });

    const status = controller.readEntryStatusForTests(EPIC_ID);
    expect(status?.presentation.kind).toBe("ready");
    expect(status?.hasSession).toBe(true);
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBe(handle);
    expect(seen.constructions).toBe(constructionsBefore);
  });

  describe("the wait for an owner that has not proved itself", () => {
    const THIRD = ESTABLISHING_DEADLINE_MS / 3;

    /** A host row moves somewhere else: the coarse wake every waiting run hears. */
    function unrelatedHostRowMoves(): void {
      installHostConnectionRegistrySource({
        directory: {
          findById: () => null,
          onDirectoryChanged: () => ({ dispose: () => undefined }),
        },
        leases: null,
      });
    }

    /** The warm remote handle, its owner unreadable, and a reader waiting at t=0. */
    function waitingReader() {
      seen.remotePublicKey = "key-before";
      const handle = warmHandleOf("row-1");
      seen.clientUser = null;
      const constructionsBefore = seen.constructions;
      vi.useFakeTimers();
      const token = acquire("row-2");
      expect(token.read().kind).toBe("acquiring");
      return { handle, token, constructionsBefore };
    }

    function presentation() {
      return getEpicSessionController().readEntryStatusForTests(EPIC_ID)
        ?.presentation.kind;
    }

    afterEach(() => {
      resetHostConnectionRegistryForTest();
    });

    it("W1: fails at the deadline counted from the first wait, however many host-row notifications arrive meanwhile", () => {
      const { token, constructionsBefore } = waitingReader();

      vi.advanceTimersByTime(THIRD);
      unrelatedHostRowMoves();
      vi.advanceTimersByTime(THIRD);
      unrelatedHostRowMoves();
      vi.advanceTimersByTime(THIRD - 100);

      expect(token.read().kind).toBe("acquiring");

      vi.advanceTimersByTime(100);

      expect(token.read().kind).toBe("failed");
      expect(seen.constructions).toBe(constructionsBefore);
    });

    it("W1b: a warm-store notification that changes nothing is heard once, and does not restart the wait", () => {
      const { handle, token } = waitingReader();
      // A wake that subscribes anew inside its own notification is visited
      // again by the store and loops: bounded here so the failure is a
      // message, not a hung worker.
      const subscribe = handle.store.subscribe.bind(handle.store);
      let subscriptions = 0;
      vi.spyOn(handle.store, "subscribe").mockImplementation((listener) => {
        subscriptions += 1;
        if (subscriptions > 20) {
          throw new Error("the wake re-subscribed inside its own notification");
        }
        return subscribe(listener);
      });

      vi.advanceTimersByTime(THIRD);
      act(() => {
        handle.store.setState((state) => ({ ...state }));
      });
      vi.advanceTimersByTime(ESTABLISHING_DEADLINE_MS - THIRD - 100);

      expect(token.read().kind).toBe("acquiring");

      vi.advanceTimersByTime(100);

      expect(token.read().kind).toBe("failed");
    });

    it("W4: fails at the deadline counted from the first wait, however many readers attach to the task meanwhile", () => {
      const { token, constructionsBefore } = waitingReader();

      // A second card for the same task attaches, and another: each restarts
      // the run without a notification.
      vi.advanceTimersByTime(THIRD);
      const second = acquire("row-3");
      vi.advanceTimersByTime(THIRD);
      const third = acquire("row-4");
      vi.advanceTimersByTime(THIRD - 100);

      expect(token.read().kind).toBe("acquiring");
      expect(second.read().kind).toBe("acquiring");
      expect(third.read().kind).toBe("acquiring");

      vi.advanceTimersByTime(100);

      expect(token.read().kind).toBe("failed");
      expect(second.read().kind).toBe("failed");
      expect(third.read().kind).toBe("failed");
      expect(seen.constructions).toBe(constructionsBefore);
    });

    it("W2: a Retry after the failure is a new attempt with its own full deadline", () => {
      const { token, constructionsBefore } = waitingReader();
      vi.advanceTimersByTime(ESTABLISHING_DEADLINE_MS);
      expect(token.read().kind).toBe("failed");

      token.retry();
      expect(token.read().kind).toBe("acquiring");
      vi.advanceTimersByTime(ESTABLISHING_DEADLINE_MS - 100);

      expect(token.read().kind).toBe("acquiring");

      vi.advanceTimersByTime(100);

      expect(token.read().kind).toBe("failed");
      expect(seen.constructions).toBe(constructionsBefore);
    });

    it("W3: an owner reading that arrives mid-wait admits the handle, and nothing fails at the old deadline", async () => {
      const { handle, token, constructionsBefore } = waitingReader();

      vi.advanceTimersByTime(5_000);
      unrelatedHostRowMoves();
      vi.advanceTimersByTime(3_000);
      seen.clientUser = "user-fixture-1";
      await act(async () => {
        handle.store.setState((state) => ({ ...state }));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(token.read().kind).toBe("ready");

      vi.advanceTimersByTime(ESTABLISHING_DEADLINE_MS);

      expect(token.read().kind).toBe("ready");
      expect(presentation()).toBe("ready");
      expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBe(handle);
      expect(seen.constructions).toBe(constructionsBefore);
    });
  });
});
