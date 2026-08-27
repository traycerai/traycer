import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionCreatedEpics,
  markEpicCreatedThisSession,
  sessionCreatedEpicHostId,
  unmarkEpicCreatedThisSession,
  wasEpicCreatedThisSession,
} from "@/lib/epics/session-created-epics";

// `sessionCreatedEpics` is a module-scoped Map with no eviction other than the
// explicit clears below - every test must start and end from an empty map or
// an entry from one test leaks into the next.
describe("session-created-epics", () => {
  beforeEach(() => {
    clearSessionCreatedEpics();
  });

  afterEach(() => {
    clearSessionCreatedEpics();
    vi.useRealTimers();
  });

  it("records the create host and answers both accessors for it", () => {
    markEpicCreatedThisSession("epic-1", "host-a");

    expect(sessionCreatedEpicHostId("epic-1")).toBe("host-a");
    expect(wasEpicCreatedThisSession("epic-1")).toBe(true);
  });

  it("expires the host-id seed after the 2-minute TTL but keeps the session-lifetime fact", () => {
    vi.useFakeTimers();
    markEpicCreatedThisSession("epic-1", "host-a");

    // Just past the TTL boundary (`> TTL`, not `>=`), so this proves the seed
    // is actually gone rather than landing on an off-by-one that happens to
    // still read as expired.
    vi.advanceTimersByTime(2 * 60 * 1000 + 1);

    expect(sessionCreatedEpicHostId("epic-1")).toBeNull();
    // `wasEpicCreatedThisSession` is deliberately NOT TTL-gated - the
    // existence reconciler and the access-coordinator's NOT_FOUND grace need
    // the session-lifetime fact, not the placement seed.
    expect(wasEpicCreatedThisSession("epic-1")).toBe(true);
  });

  it("does not expire the seed short of the TTL", () => {
    vi.useFakeTimers();
    markEpicCreatedThisSession("epic-1", "host-a");

    vi.advanceTimersByTime(2 * 60 * 1000 - 1);

    expect(sessionCreatedEpicHostId("epic-1")).toBe("host-a");
    expect(wasEpicCreatedThisSession("epic-1")).toBe(true);
  });

  it("answers null/false for an epic that was never recorded", () => {
    expect(sessionCreatedEpicHostId("unknown-epic")).toBeNull();
    expect(wasEpicCreatedThisSession("unknown-epic")).toBe(false);
  });

  it("unmarkEpicCreatedThisSession clears a single entry's answers", () => {
    markEpicCreatedThisSession("epic-1", "host-a");

    unmarkEpicCreatedThisSession("epic-1");

    expect(sessionCreatedEpicHostId("epic-1")).toBeNull();
    expect(wasEpicCreatedThisSession("epic-1")).toBe(false);
  });

  it("unmarkEpicCreatedThisSession on an epic not recorded is a no-op", () => {
    expect(() => unmarkEpicCreatedThisSession("never-recorded")).not.toThrow();
    expect(wasEpicCreatedThisSession("never-recorded")).toBe(false);
  });

  it("clearSessionCreatedEpics clears every recorded entry's answers", () => {
    markEpicCreatedThisSession("epic-1", "host-a");
    markEpicCreatedThisSession("epic-2", "host-b");

    clearSessionCreatedEpics();

    expect(sessionCreatedEpicHostId("epic-1")).toBeNull();
    expect(wasEpicCreatedThisSession("epic-1")).toBe(false);
    expect(sessionCreatedEpicHostId("epic-2")).toBeNull();
    expect(wasEpicCreatedThisSession("epic-2")).toBe(false);
  });
});
