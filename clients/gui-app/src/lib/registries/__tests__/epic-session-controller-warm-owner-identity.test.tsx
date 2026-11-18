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
import { waitFor } from "@testing-library/react";
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
});
