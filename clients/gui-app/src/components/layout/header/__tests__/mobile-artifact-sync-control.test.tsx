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

  it.each([
    {
      waiting: 0,
      title: "Artifacts not syncing",
      sentence:
        "Artifacts not syncing. Your changes are saved on this computer. Your other devices and teammates won’t see them yet.",
      description:
        "Your changes are saved on this computer. Your other devices and teammates won’t see them yet.",
    },
    {
      waiting: 1,
      title: "1 new artifact waiting",
      sentence:
        "1 new artifact waiting. It’s saved on this computer and will appear here when sync is back.",
      description:
        "It’s saved on this computer and will appear here when sync is back.",
    },
    {
      waiting: 2,
      title: "2 new artifacts waiting",
      sentence:
        "2 new artifacts waiting. They’re saved on this computer and will appear here when sync is back.",
      description:
        "They’re saved on this computer and will appear here when sync is back.",
    },
  ])(
    "opens the stopped sheet for $waiting waiting",
    ({ waiting, title, sentence, description }) => {
      state.reading = {
        rooms: "stopped",
        waitingNewArtifacts: waiting,
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
      expect(
        dialog.querySelector("[data-slot='drawer-title']")?.textContent,
      ).toBe(title);
      expect(
        dialog.querySelector("[data-slot='drawer-description']")?.textContent,
      ).toBe(description);
      expect(dialog.textContent).not.toContain("Syncing…");
      if (waiting === 0) {
        state.reading = {
          rooms: "current",
          waitingNewArtifacts: 0,
          pillState: "synced",
        };
        rerender(<MobileArtifactSyncControl epicId="epic" />);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.queryByText("Artifacts synced")).toBeNull();
        expect(container.childElementCount).toBe(0);
      }
    },
  );
});
