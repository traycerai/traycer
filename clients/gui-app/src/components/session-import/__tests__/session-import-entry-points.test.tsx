import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionImportStatusResponse } from "@traycer/protocol/host/session-import/contracts";
import { GeneralSettingsPanel } from "@/components/settings/panels/general-settings-panel";
import {
  progressEntryFrom,
  useSessionImportRunStore,
} from "@/stores/session-import/session-import-run-store";

/**
 * The two seams the settings entry point sits on. Mocked at module level so
 * these tests drive "is the feature available" and "what does the host say
 * the status is" directly, instead of standing up the stream transport that
 * backs the real hook.
 */
const sessionImportAvailableMock = vi.hoisted(() => ({ value: true }));
const sessionImportStatusMock = vi.hoisted(
  (): { data: SessionImportStatusResponse | undefined } => ({
    data: undefined,
  }),
);

vi.mock("@/hooks/session-import/use-session-import-available", () => ({
  useSessionImportAvailable: () => sessionImportAvailableMock.value,
}));

vi.mock("@/hooks/session-import/use-session-import-status-query", () => ({
  useSessionImportStatus: () => ({ data: sessionImportStatusMock.data }),
}));

// Stubbed so opening the dialog does not drag in the stream/host-transport
// stack the real dialog depends on.
vi.mock("@/components/session-import/session-import-dialog", () => ({
  SessionImportDialog: ({ onClose }: { readonly onClose: () => void }) => (
    <div data-testid="session-import-dialog-stub">
      <button type="button" onClick={onClose}>
        Close stub dialog
      </button>
    </div>
  ),
}));

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

function statusOf(
  overrides: Partial<SessionImportStatusResponse>,
): SessionImportStatusResponse {
  return {
    active: null,
    lastCompleted: null,
    ...overrides,
  };
}

describe("SessionImportSettingsRow (via GeneralSettingsPanel)", () => {
  beforeEach(() => {
    sessionImportAvailableMock.value = true;
    sessionImportStatusMock.data = undefined;
    useSessionImportRunStore.getState().reset();
    navigateMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  function renderPanel(): void {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <GeneralSettingsPanel />
      </QueryClientProvider>,
    );
  }

  it("is hidden entirely when session import is unavailable", () => {
    sessionImportAvailableMock.value = false;

    renderPanel();

    expect(
      screen.queryByRole("button", { name: "Import" }),
    ).toBeNull();
    // The row's label too, not just its control: the whole row is gone.
    expect(screen.queryByText("Import your work")).toBeNull();
  });

  it("shows the idle description when nothing is running and nothing has completed", () => {
    sessionImportStatusMock.data = statusOf({});

    renderPanel();

    expect(
      screen.getByRole("button", { name: "Import" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Bring work you already started in Claude Code, Codex, or OpenCode into Traycer as tasks.",
      ),
    ).toBeTruthy();
  });

  it("shows 'Importing N of M…' from the run store, winning over the status query", () => {
    sessionImportStatusMock.data = statusOf({
      lastCompleted: {
        runId: "run-old",
        counts: { imported: 9, skippedAlreadyImported: 0, failed: 0 },
        at: Date.now(),
      },
    });

    useSessionImportRunStore.getState().markStarting(new Map());
    useSessionImportRunStore.getState().applyStarted({
      runId: "run-live",
      total: 5,
      attached: false,
    });
    useSessionImportRunStore.getState().applyProgress(
      progressEntryFrom({
        runId: "run-live",
        harness: "claude",
        nativeSessionId: "session-1",
        outcome: {
          kind: "imported",
          epicId: "epic-1",
          chatId: "chat-1",
        },
      }),
    );

    renderPanel();

    expect(screen.getByText("Importing 1 of 5…")).toBeTruthy();
    expect(screen.queryByText(/Last import:/)).toBeNull();
  });

  it("shows 'Importing N of M…' from status.active when the run store is idle (post-restart)", () => {
    sessionImportStatusMock.data = statusOf({
      active: { runId: "run-remote", done: 2, total: 6 },
    });

    renderPanel();

    expect(screen.getByText("Importing 2 of 6…")).toBeTruthy();
  });

  it("keeps the idle description when status.lastCompleted is set and nothing is active", () => {
    // A finished run leaves no caption behind: the row always reads as the
    // same quiet offer once nothing is running.
    sessionImportStatusMock.data = statusOf({
      lastCompleted: {
        runId: "run-done",
        counts: { imported: 7, skippedAlreadyImported: 1, failed: 0 },
        at: Date.now(),
      },
    });

    renderPanel();

    expect(screen.queryByText(/Last import:/)).toBeNull();
    expect(
      screen.getByText(
        "Bring work you already started in Claude Code, Codex, or OpenCode into Traycer as tasks.",
      ),
    ).toBeTruthy();
  });
});
