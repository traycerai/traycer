/**
 * The leaf constants in `budget-limits.ts` must be the same binding the
 * window re-export, the tier policy, and the session-registry alias
 * consume. Value equality of two numbers is vacuous; a sentinel mock is
 * the guard that a second copy would fail.
 */
import { describe, expect, it, vi } from "vitest";

const SENTINEL_WINDOW_BYTES = 111;
const SENTINEL_HOT_DOCS = 9;
const SENTINEL_LIVE_EPICS = 7;

vi.mock("@/stores/replica-memory/budget-limits", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/stores/replica-memory/budget-limits")
    >();
  return {
    ...actual,
    TRANSCRIPT_WINDOW_MAX_BYTES: SENTINEL_WINDOW_BYTES,
    HOT_DOCS_MAX_MATERIALIZED: SENTINEL_HOT_DOCS,
    EPIC_REPLICAS_MAX_LIVE: SENTINEL_LIVE_EPICS,
    DEFAULT_MAX_LIVE_EPICS: SENTINEL_LIVE_EPICS,
  };
});

describe("budget-limits leaf bindings", () => {
  it("the window re-export, the tier policy, and the registry alias all track the mocked leaf", async () => {
    const { TRANSCRIPT_WINDOW_MAX_BYTES } =
      await import("@/stores/chats/transcript-window");
    const { ARTIFACT_ROOM_LEASE_POLICY } =
      await import("@/stores/epics/open-epic/runtime/artifact-room-tier");
    const { DEFAULT_MAX_LIVE_EPICS } =
      await import("@/stores/epics/open-epic/session-registry");
    expect(TRANSCRIPT_WINDOW_MAX_BYTES).toBe(SENTINEL_WINDOW_BYTES);
    expect(ARTIFACT_ROOM_LEASE_POLICY.maxMaterialized).toBe(SENTINEL_HOT_DOCS);
    expect(DEFAULT_MAX_LIVE_EPICS).toBe(SENTINEL_LIVE_EPICS);
  });
});
