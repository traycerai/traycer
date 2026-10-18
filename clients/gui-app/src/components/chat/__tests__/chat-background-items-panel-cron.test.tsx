import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { disposeManagedCommandChatSessions } from "@/stores/managed-commands/test-support/managed-command-chat-session";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";

// Same single faked boundary as `chat-background-items-panel.test.tsx`.
vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAll: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAllIsPending: () => false,
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandConfigureIsPending: () => false,
    useManagedCommandRelaunchOnHostRestart: (
      _target: unknown,
      streamed: { relaunchOnHostRestart: boolean },
    ) => streamed.relaunchOnHostRestart,
    useManagedCommandConfigure: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeld: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeldIsPending: () => false,
  }),
);
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({
    request: vi.fn(),
    getActiveHostId: () => "host-1",
  }),
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

import { BackgroundItemsPanel } from "@/components/chat/chat-background-items-panel";
import { formatClockTime, formatWaitTime } from "@/lib/relative-time";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";

const queryClient = new QueryClient({
  defaultOptions: { mutations: { retry: false } },
});

const CRON_ITEM: Extract<BackgroundItem, { kind: "cron" }> = {
  taskId: "cron-job-1",
  kind: "cron",
  title: "Every 5 minutes",
  blockId: "cron-job-1",
  parentTaskId: null,
  schedule: "*/5 * * * *",
  humanSchedule: "Every 5 minutes",
  prompt: "check the build and report failures",
  recurring: true,
  scheduledFor: null,
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60 * 1000;

function renderCronPanel(
  items: ReadonlyArray<BackgroundItem>,
  handlers: {
    onStopItem: () => string | null;
    onStopAll: () => string | null;
    onStopSession: () => string | null;
  },
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TabHostProvider hostId="host-1">
        <BackgroundItemsPanel
          items={items}
          epicId="epic-1"
          chatId="chat-1"
          viewTabId="tab-1"
          canAct
          readOnly={false}
          pendingStopTaskIds={new Set()}
          stopAllPending={false}
          sessionStopPending={false}
          turnActive={false}
          scrollRegionMaxHeightClass="max-h-96"
          separated={false}
          onItemClick={() => undefined}
          onStopItem={handlers.onStopItem}
          onStopAll={handlers.onStopAll}
          onStopSession={handlers.onStopSession}
        />
      </TabHostProvider>
    </QueryClientProvider>,
  );
}

function openPanel(): void {
  fireEvent.click(screen.getByRole("button", { name: /Background/ }));
}

describe("<BackgroundItemsPanel /> cron rows (T15)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    disposeManagedCommandChatSessions();
  });

  it("shows the human schedule, the raw schedule and the prompt as plain text", () => {
    renderCronPanel([CRON_ITEM], {
      onStopItem: () => null,
      onStopAll: () => null,
      onStopSession: () => null,
    });
    openPanel();
    expect(screen.getByText(/Every 5 minutes/)).toBeTruthy();
    expect(screen.getByText(/\*\/5 \* \* \* \*/)).toBeTruthy();
    expect(
      screen.getByText(/check the build and report failures/),
    ).toBeTruthy();
  });

  it("says jobs run only while the session is alive and stop ten minutes after the last real activity, with no countdown", () => {
    renderCronPanel([CRON_ITEM], {
      onStopItem: () => null,
      onStopAll: () => null,
      onStopSession: () => null,
    });
    openPanel();
    const text = document.body.textContent;
    expect(text).toContain(
      "scheduled jobs run while the session is otherwise alive",
    );
    expect(text).toContain("stop ten minutes after the last real activity");
    expect(text).toContain(
      "a job already running at that moment finishes first",
    );
    expect(text).not.toMatch(/Waiting until|in \d+ ?(m|min|s)\b/);
  });

  it("shows the CLI-reported next run under the schedule when it is in the future", () => {
    const scheduledFor = Date.now() + 2 * HOUR_MS;
    renderCronPanel([{ ...CRON_ITEM, scheduledFor }], {
      onStopItem: () => null,
      onStopAll: () => null,
      onStopSession: () => null,
    });
    openPanel();
    const line = screen.getByText(/^Next run /);
    expect(line.textContent).toBe(
      `Next run ${formatWaitTime(scheduledFor, Date.now())}`,
    );
    // Still a row with a schedule and the session-lifetime sentence, no countdown.
    expect(document.body.textContent).toContain(
      "scheduled jobs run while the session is otherwise alive",
    );
    expect(document.body.textContent).not.toMatch(/Waiting until/);
  });

  describe("seven-day boundary", () => {
    // A whole-minute clock, so the shared minute sample equals Date.now().
    const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime();

    afterEach(() => {
      vi.useRealTimers();
    });

    function renderAt(scheduledFor: number): string {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      renderCronPanel([{ ...CRON_ITEM, scheduledFor }], {
        onStopItem: () => null,
        onStopAll: () => null,
        onStopSession: () => null,
      });
      openPanel();
      return screen.getByText(/^Next run /).textContent;
    }

    it("keeps the weekday-and-time form at exactly seven days", () => {
      const at = NOW + 7 * DAY_MS;
      expect(renderAt(at)).toBe(`Next run ${formatWaitTime(at, NOW)}`);
    });

    it("shows an absolute local calendar date and time just beyond seven days", () => {
      const at = NOW + 7 * DAY_MS + MINUTE_MS;
      const text = renderAt(at);
      const date = new Date(at).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
      expect(text).toContain(date);
      expect(text).toContain(formatClockTime(at));
      expect(text).not.toBe(`Next run ${formatWaitTime(at, NOW)}`);
    });
  });

  it("renders no next-run line for a null time", () => {
    renderCronPanel([CRON_ITEM], {
      onStopItem: () => null,
      onStopAll: () => null,
      onStopSession: () => null,
    });
    openPanel();
    expect(screen.queryByText(/Next run/)).toBeNull();
    expect(screen.getByText(/\*\/5 \* \* \* \*/)).toBeTruthy();
  });

  it("renders no next-run line for a time that has already passed", () => {
    renderCronPanel([{ ...CRON_ITEM, scheduledFor: Date.now() - HOUR_MS }], {
      onStopItem: () => null,
      onStopAll: () => null,
      onStopSession: () => null,
    });
    openPanel();
    expect(screen.queryByText(/Next run/)).toBeNull();
    expect(screen.getByText(/Every 5 minutes/)).toBeTruthy();
  });

  it("offers no per-row stop and no Stop all when only crons are listed", () => {
    const onStopItem = vi.fn(() => null);
    const onStopAll = vi.fn(() => null);
    renderCronPanel([CRON_ITEM], {
      onStopItem,
      onStopAll,
      onStopSession: () => null,
    });
    openPanel();
    expect(screen.queryByRole("button", { name: /stop|cancel/i })).toBeNull();
    expect(screen.queryByTestId("background-stop-all")).toBeNull();
    expect(onStopItem).not.toHaveBeenCalled();
    expect(onStopAll).not.toHaveBeenCalled();
  });

  it("a cron does not add a Stop all beside a task: the task keeps its stop, the cron gets none", () => {
    const onStopAll = vi.fn(() => null);
    const onStopSession = vi.fn(() => null);
    const command: BackgroundItem = {
      taskId: "task-1",
      kind: "command",
      title: "sleep 900",
      blockId: "tool-1",
      parentTaskId: null,
      scheduledFor: null,
      individualStopUnavailable: null,
    };
    renderCronPanel([command, CRON_ITEM], {
      onStopItem: () => null,
      onStopAll,
      onStopSession,
    });
    openPanel();
    const stops = screen.getAllByRole("button", { name: /^Stop/ });
    expect(stops.length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: /cron|scheduled job.*stop/i }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop other items" }));
    expect(onStopAll).toHaveBeenCalledTimes(1);
    expect(onStopSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
  });

  it("counts and names scheduled jobs before stopping a session for a gated command", () => {
    const gatedCommand: BackgroundItem = {
      taskId: "gated-command",
      kind: "command",
      title: "Codex command",
      blockId: "gated-command-tool",
      parentTaskId: null,
      scheduledFor: null,
      individualStopUnavailable: {
        providerLabel: "Codex",
        minVersion: "0.146.0",
      },
    };
    const onStopSession = vi.fn(() => "action-1");
    renderCronPanel([gatedCommand, CRON_ITEM], {
      onStopItem: () => null,
      onStopAll: () => null,
      onStopSession,
    });

    openPanel();
    // The gated command forces the session-stop escalation, which ends the
    // scheduled job along with everything else - so the button reads "Stop
    // all", not "Stop other items" (see the label test below).
    fireEvent.click(screen.getByRole("button", { name: "Stop all" }));

    const dialog = screen.getByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain(
      "Stopping the session ends all 2 background items.",
    );
    expect(dialog.textContent).toContain("1 scheduled job");
    expect(onStopSession).not.toHaveBeenCalled();
  });

  it("labels the escalation path Stop all, not Stop other items, since confirming also ends the scheduled job", () => {
    const gatedCommand: BackgroundItem = {
      taskId: "gated-command",
      kind: "command",
      title: "Codex command",
      blockId: "gated-command-tool",
      parentTaskId: null,
      scheduledFor: null,
      individualStopUnavailable: {
        providerLabel: "Codex",
        minVersion: "0.146.0",
      },
    };
    renderCronPanel([gatedCommand, CRON_ITEM], {
      onStopItem: () => null,
      onStopAll: () => null,
      onStopSession: () => "action-1",
    });

    openPanel();

    // "Stop other items" promises the cron job survives, but the click opens
    // the session-stop confirmation, whose confirm action ends the scheduled
    // job along with everything else - the same escalation the plain,
    // non-cron path already labels "Stop all".
    expect(
      screen.queryByRole("button", { name: "Stop other items" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Stop all" })).toBeTruthy();
  });
});
