import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => {
  const base = vi.fn();
  return {
    toast: Object.assign(base, {
      warning: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    }),
  };
});

import type { EpicFileEventsServerFrame } from "@traycer/protocol/host/epic/files";
import { useEpicFileRefusals } from "@/hooks/epic/use-epic-file-refusals";
import {
  __resetEpicFileEventsForTests,
  recordEpicFileEvent,
} from "@/lib/epic-files/file-events-store";

function refusedFrame(path: string): EpicFileEventsServerFrame {
  return {
    kind: "refused",
    path,
    reason: "secret-shaped",
    hasBinaryPayload: false,
  };
}

beforeEach(() => {
  __resetEpicFileEventsForTests();
});

describe("useEpicFileRefusals", () => {
  it("starts empty for an epic with no refusals", () => {
    const { result } = renderHook(() => useEpicFileRefusals("epic-empty"));
    expect(result.current).toEqual([]);
  });

  it("re-renders with the new row once a refusal is recorded", () => {
    const { result } = renderHook(() => useEpicFileRefusals("epic-live"));
    expect(result.current).toEqual([]);

    act(() => {
      recordEpicFileEvent("epic-live", refusedFrame("files/secret.env"));
    });

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ name: "secret.env" });
  });

  it("scopes refusals per epicId", () => {
    const { result: resultA } = renderHook(() => useEpicFileRefusals("epic-a"));
    const { result: resultB } = renderHook(() => useEpicFileRefusals("epic-b"));

    act(() => {
      recordEpicFileEvent("epic-a", refusedFrame("files/a.env"));
    });

    expect(resultA.current).toHaveLength(1);
    expect(resultB.current).toEqual([]);
  });

  it("returns a stable reference across an unrelated re-render", () => {
    const { result, rerender } = renderHook(
      ({ epicId }: { epicId: string }) => useEpicFileRefusals(epicId),
      { initialProps: { epicId: "epic-stable" } },
    );

    act(() => {
      recordEpicFileEvent("epic-stable", refusedFrame("files/a.env"));
    });

    const first = result.current;
    rerender({ epicId: "epic-stable" });
    expect(result.current).toBe(first);
  });
});
