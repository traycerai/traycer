import "../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { domMax, LazyMotion } from "motion/react";
import {
  FILE_AUTOSAVE_SAVING_MIN_VISIBLE_MS,
  FILE_AUTOSAVE_SAVING_REVEAL_DELAY_MS,
  FILE_STATUS_CROSSFADE_MS,
  FileAutosaveStatus,
} from "@/components/diff/file-autosave-status";
import type { FileEditRuntimeState } from "@/lib/workspace/file-edit-runtime";

const DIRTY_STATE: FileEditRuntimeState = {
  identity: {
    userId: null,
    hostId: "host-A",
    workspacePath: "/work/repo",
    filePath: "src/index.ts",
  },
  baselineContent: "const value = 1;\n",
  baselineRevision: "baseline-revision",
  draftContent: "const value = 2;\n",
  contentRevision: 1,
  status: "dirty",
  isDirty: true,
  ownerSurfaceId: "surface-A",
  conflict: null,
  error: null,
  recoveryStatus: "idle",
  lastSavedAt: null,
};

const SAVED_STATE: FileEditRuntimeState = {
  ...DIRTY_STATE,
  baselineContent: DIRTY_STATE.draftContent,
  baselineRevision: "saved-revision",
  status: "clean",
  isDirty: false,
  lastSavedAt: 1,
};

const RECOVERY_UNAVAILABLE_STATE: FileEditRuntimeState = {
  ...SAVED_STATE,
  ownerSurfaceId: null,
  recoveryStatus: "unavailable",
};

const RECOVERED_DRAFT_STATE: FileEditRuntimeState = {
  ...DIRTY_STATE,
  ownerSurfaceId: null,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("<FileAutosaveStatus />", () => {
  it("crossfades ordinary autosave states inside one fixed-size icon", () => {
    vi.useFakeTimers();
    const actions = {
      onRetry: vi.fn(),
      onKeepMine: vi.fn(),
      onUseDisk: vi.fn(),
    };
    const rendered = render(
      <LazyMotion features={domMax}>
        <FileAutosaveStatus
          appearance="pill"
          state={SAVED_STATE}
          {...actions}
        />
      </LazyMotion>,
    );

    const status = screen.getByTestId("file-autosave-status");
    const pill = screen.getByTestId("file-autosave-pill");
    expect(status.getAttribute("data-status")).toBe("saved");
    expect(pill.getAttribute("data-appearance")).toBe("minimal");
    expect(pill.className).toContain("size-5");
    expect(pill.className).not.toContain("w-max");
    expect(pill.textContent).toBe("");
    expect(pill.getAttribute("aria-label")).toBe("All changes saved");
    expect(
      pill.querySelector('[data-status-transition="crossfade"]'),
    ).toBeTruthy();
    expect(FILE_STATUS_CROSSFADE_MS).toBeLessThanOrEqual(100);
    expect(pill.firstElementChild?.className).not.toContain("zoom-in");
    expect(pill.firstElementChild?.className).not.toContain("slide-in");

    rendered.rerender(
      <LazyMotion features={domMax}>
        <FileAutosaveStatus
          appearance="pill"
          state={DIRTY_STATE}
          {...actions}
        />
      </LazyMotion>,
    );
    expect(status.getAttribute("data-status")).toBe("dirty");
    expect(screen.getByTestId("file-autosave-pill")).toBe(pill);
    expect(pill.textContent).toBe("");

    act(() => {
      vi.advanceTimersByTime(FILE_AUTOSAVE_SAVING_REVEAL_DELAY_MS);
    });
    expect(status.getAttribute("data-status")).toBe("saving");
    expect(screen.getByTestId("file-autosave-spinner")).toBeTruthy();
    expect(screen.getByTestId("file-autosave-pill")).toBe(pill);

    rendered.rerender(
      <LazyMotion features={domMax}>
        <FileAutosaveStatus
          appearance="pill"
          state={SAVED_STATE}
          {...actions}
        />
      </LazyMotion>,
    );
    expect(status.getAttribute("data-status")).toBe("saving");
    expect(screen.getByTestId("file-autosave-pill")).toBe(pill);

    act(() => {
      vi.advanceTimersByTime(FILE_AUTOSAVE_SAVING_MIN_VISIBLE_MS - 1);
    });
    expect(status.getAttribute("data-status")).toBe("saving");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(status.getAttribute("data-status")).toBe("saved");
    // The old spinner remains only for the short opacity exit instead of
    // disappearing in the same frame as the new status arrives.
    expect(screen.queryByTestId("file-autosave-spinner")).toBeTruthy();
    expect(screen.getByTestId("file-autosave-pill")).toBe(pill);
    expect(screen.queryByText("Saved")).toBeNull();
    expect(pill.getAttribute("aria-label")).toBe("All changes saved");
  });

  it("uses the same minimal ordinary indicator in compact file headers", () => {
    render(
      <LazyMotion features={domMax}>
        <FileAutosaveStatus
          appearance="quiet"
          state={SAVED_STATE}
          onRetry={vi.fn()}
          onKeepMine={vi.fn()}
          onUseDisk={vi.fn()}
        />
      </LazyMotion>,
    );

    const pill = screen.getByTestId("file-autosave-pill");
    expect(pill.getAttribute("data-appearance")).toBe("minimal");
    expect(pill.className).toContain("size-5");
    expect(pill.className).toContain("text-muted-foreground");
    expect(pill.className).not.toContain("bg-muted/45");
    expect(pill.className).not.toContain("border-border/70");
    expect(pill.className).not.toContain("shadow-xs");
  });

  it("stays visible for a recovery-unavailable state even when the file is clean and unowned", () => {
    render(
      <LazyMotion features={domMax}>
        <FileAutosaveStatus
          appearance="pill"
          state={RECOVERY_UNAVAILABLE_STATE}
          onRetry={vi.fn()}
          onKeepMine={vi.fn()}
          onUseDisk={vi.fn()}
        />
      </LazyMotion>,
    );

    const status = screen.getByTestId("file-autosave-status");
    expect(status.getAttribute("data-status")).toBe("recovery-unavailable");
    expect(screen.getByText("Recovery unavailable")).toBeTruthy();
  });

  it("keeps a detached recovered draft labelled instead of reducing it to an icon", () => {
    render(
      <LazyMotion features={domMax}>
        <FileAutosaveStatus
          appearance="quiet"
          state={RECOVERED_DRAFT_STATE}
          onRetry={vi.fn()}
          onKeepMine={vi.fn()}
          onUseDisk={vi.fn()}
        />
      </LazyMotion>,
    );

    const pill = screen.getByTestId("file-autosave-pill");
    expect(pill.getAttribute("data-appearance")).toBe("quiet");
    expect(screen.getByText("Recovered draft")).toBeTruthy();
  });
});
