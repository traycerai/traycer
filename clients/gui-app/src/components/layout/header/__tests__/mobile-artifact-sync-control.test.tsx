import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ArtifactSyncReading } from "@/lib/epic-sync-pill-state";
import { MobileArtifactSyncControl } from "@/components/layout/header/mobile-artifact-sync-control";

const state = vi.hoisted((): { reading: ArtifactSyncReading | null } => ({
  reading: null,
}));
vi.mock("@/lib/epic-selectors", () => ({
  useRegisteredEpicArtifactSyncReading: () => state.reading,
}));
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "light", themePreset: "default" }),
}));

describe("MobileArtifactSyncControl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.reading = null;
  });
  afterEach(() => vi.useRealTimers());

  it("renders nothing when calm", () => {
    const { container } = render(<MobileArtifactSyncControl epicId="epic" />);
    expect(container.childElementCount).toBe(0);
  });

  it("opens the warning sheet and closes it when the warning clears", () => {
    state.reading = {
      rooms: "stopped",
      waitingNewArtifacts: 1,
      pillState: "hostPending",
    };
    const { rerender } = render(<MobileArtifactSyncControl epicId="epic" />);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Syncing…" }));
    expect(screen.getByRole("dialog").textContent).toBe(
      "Syncing…1 new artifact waiting. It’s saved on this computer and will appear here when sync is back.",
    );
    state.reading = {
      rooms: "current",
      waitingNewArtifacts: 0,
      pillState: "synced",
    };
    rerender(<MobileArtifactSyncControl epicId="epic" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("status", { name: "Artifacts synced" }),
    ).not.toBeNull();
  });
});
