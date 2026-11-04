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

  it("renders nothing while rooms are still retrying", () => {
    state.reading = {
      rooms: "retrying",
      waitingNewArtifacts: 1,
      pillState: "hostPending",
    };
    const { container } = render(<MobileArtifactSyncControl epicId="epic" />);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(container.childElementCount).toBe(0);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens the stopped sheet and renders nothing once the warning clears", () => {
    const sentence =
      "1 new artifact waiting. It’s saved on this computer and will appear here when sync is back.";
    state.reading = {
      rooms: "stopped",
      waitingNewArtifacts: 1,
      pillState: "hostPending",
    };
    const { container, rerender } = render(
      <MobileArtifactSyncControl epicId="epic" />,
    );
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    const button = screen.getByRole("button", { name: sentence });
    expect(button.textContent).not.toContain("Syncing…");
    expect(button.querySelector("span")?.className).toContain("bg-warning");
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("[data-slot='drawer-title']")?.textContent).toBe(
      "1 new artifact waiting",
    );
    expect(
      dialog.querySelector("[data-slot='drawer-description']")?.textContent,
    ).toBe(sentence);
    expect(dialog.textContent).not.toContain("Syncing…");
    state.reading = {
      rooms: "current",
      waitingNewArtifacts: 0,
      pillState: "synced",
    };
    rerender(<MobileArtifactSyncControl epicId="epic" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Artifacts synced")).toBeNull();
    expect(container.childElementCount).toBe(0);
  });
});
