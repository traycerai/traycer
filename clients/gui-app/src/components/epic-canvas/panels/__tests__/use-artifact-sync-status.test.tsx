import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  useArtifactSyncStatus,
  type ArtifactSyncStatus,
} from "@/components/epic-canvas/panels/use-artifact-sync-status";
import type { ArtifactSyncReading } from "@/lib/epic-sync-pill-state";

const retrying: ArtifactSyncReading = {
  rooms: "retrying",
  waitingNewArtifacts: 0,
  pillState: "hostPending",
};
const current: ArtifactSyncReading = {
  rooms: "current",
  waitingNewArtifacts: 0,
  pillState: "synced",
};
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe("useArtifactSyncStatus", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays calm without a reading, or with unknown rooms", () => {
    const { result, rerender } = renderHook<
      ArtifactSyncStatus,
      ArtifactSyncReading | null
    >((reading: ArtifactSyncReading | null) => useArtifactSyncStatus(reading), {
      initialProps: null,
    });
    advance(20_000);
    expect(result.current).toEqual({ kind: "calm" });
    rerender({ ...retrying, rooms: null });
    advance(20_000);
    expect(result.current).toEqual({ kind: "calm" });
  });

  it("warns after 15 seconds and returns to calm as soon as it clears", () => {
    const { result, rerender } = renderHook(
      (reading: ArtifactSyncReading | null) => useArtifactSyncStatus(reading),
      { initialProps: retrying },
    );
    advance(14_999);
    expect(result.current).toEqual({ kind: "calm" });
    advance(1);
    expect(result.current).toEqual({
      kind: "retrying",
      title: "Artifacts not syncing",
      sentence:
        "Artifacts not syncing. Your changes are saved on this computer. Your other devices and teammates won’t see them yet. Retrying on its own.",
    });
    rerender(current);
    expect(result.current).toEqual({ kind: "calm" });
    advance(5_000);
    expect(result.current).toEqual({ kind: "calm" });
  });

  it.each([
    { name: "missing reading", reading: null },
    { name: "unknown rooms", reading: { ...current, rooms: null } },
  ] satisfies ReadonlyArray<{
    name: string;
    reading: ArtifactSyncReading | null;
  }>)(
    "does not claim recovery after a warning clears to $name",
    ({ reading }) => {
      const { result, rerender } = renderHook<
        ArtifactSyncStatus,
        ArtifactSyncReading | null
      >((value) => useArtifactSyncStatus(value), { initialProps: retrying });
      advance(15_000);
      expect(result.current.kind).toBe("retrying");
      rerender(reading);
      expect(result.current).toEqual({ kind: "calm" });
    },
  );

  it("does not show recovery when the issue clears within the grace", () => {
    const { result, rerender } = renderHook(
      (reading: ArtifactSyncReading) => useArtifactSyncStatus(reading),
      { initialProps: retrying },
    );
    advance(14_999);
    rerender(current);
    advance(10_000);
    expect(result.current).toEqual({ kind: "calm" });
  });

  it("does not warn or show recovery over a down link", () => {
    const { result, rerender } = renderHook(
      (reading: ArtifactSyncReading) => useArtifactSyncStatus(reading),
      { initialProps: retrying },
    );
    advance(15_000);
    rerender({ ...retrying, pillState: "offline" });
    expect(result.current).toEqual({ kind: "calm" });
    advance(20_000);
    expect(result.current).toEqual({ kind: "calm" });
  });

  it.each([
    {
      rooms: "retrying",
      waiting: 0,
      kind: "retrying",
      title: "Artifacts not syncing",
      sentence:
        "Artifacts not syncing. Your changes are saved on this computer. Your other devices and teammates won’t see them yet. Retrying on its own.",
    },
    {
      rooms: "stopped",
      waiting: 0,
      kind: "stopped",
      title: "Artifacts not syncing",
      sentence:
        "Artifacts not syncing. Your changes are saved on this computer. Your other devices and teammates won’t see them yet.",
    },
    {
      rooms: "retrying",
      waiting: 1,
      kind: "retrying",
      title: "1 new artifact waiting",
      sentence:
        "1 new artifact waiting. It’s saved on this computer and will appear here when sync is back. Retrying on its own.",
    },
    {
      rooms: "stopped",
      waiting: 1,
      kind: "stopped",
      title: "1 new artifact waiting",
      sentence:
        "1 new artifact waiting. It’s saved on this computer and will appear here when sync is back.",
    },
    {
      rooms: "retrying",
      waiting: 2,
      kind: "retrying",
      title: "2 new artifacts waiting",
      sentence:
        "2 new artifacts waiting. They’re saved on this computer and will appear here when sync is back. Retrying on its own.",
    },
    {
      rooms: "stopped",
      waiting: 2,
      kind: "stopped",
      title: "2 new artifacts waiting",
      sentence:
        "2 new artifacts waiting. They’re saved on this computer and will appear here when sync is back.",
    },
  ] as const)(
    "shows the correct warning for $rooms and $waiting waiting",
    ({ rooms, waiting, kind, title, sentence }) => {
      const { result } = renderHook(() =>
        useArtifactSyncStatus({
          rooms,
          waitingNewArtifacts: waiting,
          pillState: "hostPending",
        }),
      );
      advance(15_000);
      expect(result.current).toEqual({ kind, title, sentence });
    },
  );

  it("does not restart grace when the warning changes", () => {
    const { result, rerender } = renderHook(
      (reading: ArtifactSyncReading) => useArtifactSyncStatus(reading),
      { initialProps: retrying },
    );
    advance(10_000);
    rerender({ ...retrying, waitingNewArtifacts: 1 });
    advance(5_000);
    expect(result.current.kind).toBe("retrying");
  });
});
