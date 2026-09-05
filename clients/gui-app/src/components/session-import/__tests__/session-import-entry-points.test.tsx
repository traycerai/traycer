import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionImportStatusResponse } from "@traycer/protocol/host/session-import/contracts";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  StreamRuntimeContext,
  type StreamRuntimeBinding,
} from "@/lib/host/stream-runtime-context";
import { HostImportMigrationSection } from "@/components/settings/panels/host-import-migration-section";
import {
  progressEntryFrom,
  useSessionImportRunStore,
} from "@/stores/session-import/session-import-run-store";

const HOST = "host-test";

/**
 * A stub satisfying `IHostStreamClient` honestly rather than casting - the
 * section never calls through to it, since every host RPC it drives is mocked
 * separately below.
 */
function fakeWsStreamClient(): IHostStreamClient<HostStreamRpcRegistry> {
  return {
    subscribe: () => {
      throw new Error("not exercised by this test");
    },
    subscribeWithParamsProvider: () => {
      throw new Error("not exercised by this test");
    },
    close: () => undefined,
    isClosed: () => false,
    isReady: () => true,
    notifyBearerRotated: () => undefined,
    reconnectAll: () => undefined,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => undefined,
    getClosedReason: () => null,
    onClosed: () => () => undefined,
    instanceId: "fake-ws-stream-client",
  };
}

// PROVIDED rather than mocked: the section reads its binding from
// `StreamRuntimeContext`, exactly as it does beneath the Host Overview's own
// re-provider, so the tests below exercise that read instead of replacing it.
const STREAM_BINDING: StreamRuntimeBinding = {
  wsStreamClient: fakeWsStreamClient(),
  hostId: HOST,
  retain: null,
};

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
  useSessionImportAvailableFor: () => sessionImportAvailableMock.value,
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

function statusOf(
  overrides: Partial<SessionImportStatusResponse>,
): SessionImportStatusResponse {
  return {
    active: null,
    lastCompleted: null,
    ...overrides,
  };
}

describe("Import your work row (via HostImportMigrationSection)", () => {
  beforeEach(() => {
    sessionImportAvailableMock.value = true;
    sessionImportStatusMock.data = undefined;
    useSessionImportRunStore.setState({ runs: new Map() });
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
        <StreamRuntimeContext.Provider value={STREAM_BINDING}>
          <HostImportMigrationSection hostId={HOST} />
        </StreamRuntimeContext.Provider>
      </QueryClientProvider>,
    );
  }

  it("is hidden entirely when session import is unavailable", () => {
    sessionImportAvailableMock.value = false;

    renderPanel();

    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
    // The row's label too, not just its control: the whole row is gone.
    expect(screen.queryByText("Import your work")).toBeNull();
  });

  it("shows the idle description when nothing is running and nothing has completed", () => {
    sessionImportStatusMock.data = statusOf({});

    renderPanel();

    expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
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

    useSessionImportRunStore.getState().markStarting(HOST, new Map());
    useSessionImportRunStore.getState().applyStarted(HOST, {
      runId: "run-live",
      total: 5,
      attached: false,
    });
    useSessionImportRunStore.getState().applyProgress(
      HOST,
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
