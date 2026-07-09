import { describe, expect, it, vi, afterEach } from "vitest";
import {
  createNotificationDemux,
  readNotificationEmissionRows,
  shouldSuppressNotificationEmissionForFocus,
  subscribeNotificationEmissionSources,
  type NotificationDemux,
  type NotificationEmissionChannel,
  type NotificationEmissionClock,
  type NotificationEmissionRow,
} from "@/lib/notifications/notification-demux";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import type { NotificationPayload } from "@/lib/notifications";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/contracts";

interface ScheduledTimer {
  readonly id: number;
  readonly dueAt: number;
  readonly handler: () => void;
}

class FakeClock implements NotificationEmissionClock {
  private nowMs = 0;
  private nextTimerId = 1;
  private timers: ReadonlyArray<ScheduledTimer> = [];

  now(): number {
    return this.nowMs;
  }

  setTimeout(handler: () => void, delayMs: number): number {
    const id = this.nextTimerId;
    this.nextTimerId += 1;
    this.timers = [
      ...this.timers,
      { id, dueAt: this.nowMs + delayMs, handler },
    ];
    return id;
  }

  clearTimeout(timerId: number): void {
    this.timers = this.timers.filter((timer) => timer.id !== timerId);
  }

  advanceBy(ms: number): void {
    this.nowMs += ms;
    let due = this.nextDueTimer();
    while (due !== null && due.dueAt <= this.nowMs) {
      this.timers = this.timers.filter((timer) => timer.id !== due?.id);
      due.handler();
      due = this.nextDueTimer();
    }
  }

  private nextDueTimer(): ScheduledTimer | null {
    const sorted = [...this.timers].sort((a, b) => a.dueAt - b.dueAt);
    return sorted[0] ?? null;
  }
}

function createHarness(input: {
  readonly accepts: (row: NotificationEmissionRow) => boolean;
  readonly shouldSuppressForFocus: (row: NotificationEmissionRow) => boolean;
}): {
  readonly clock: FakeClock;
  readonly demux: NotificationDemux;
  rows: ReadonlyArray<NotificationEmissionRow>;
  emissions: ReadonlyArray<ReadonlyArray<NotificationEmissionRow>>;
} {
  const clock = new FakeClock();
  const emissions: ReadonlyArray<NotificationEmissionRow>[] = [];
  let rows: ReadonlyArray<NotificationEmissionRow> = [];
  const channel: NotificationEmissionChannel = {
    id: "test",
    accepts: input.accepts,
    emit: (rows) => {
      emissions.push(rows);
    },
  };
  const demux = createNotificationDemux({
    holdMs: 1_000,
    clock,
    channels: [channel],
    getRows: () => rows,
    shouldSuppressForFocus: input.shouldSuppressForFocus,
  });
  demux.observe(rows);
  return {
    clock,
    demux,
    emissions,
    get rows() {
      return rows;
    },
    set rows(nextRows: ReadonlyArray<NotificationEmissionRow>) {
      rows = nextRows;
    },
  };
}

function observe(
  demux: NotificationDemux,
  rows: ReadonlyArray<NotificationEmissionRow>,
): void {
  demux.observe(rows);
}

function hostRow(input: {
  readonly id: string;
  readonly createdAt: number;
  readonly readAt: number | null;
  readonly hostKind: NonNullable<NotificationEmissionRow["hostKind"]>;
  readonly text: string;
  readonly payload: NotificationPayload | null;
}): NotificationEmissionRow {
  return {
    feedId: `host:${input.id}`,
    source: "host",
    sourceId: input.id,
    createdAt: input.createdAt,
    readAt: input.readAt,
    text: input.text,
    payload: input.payload,
    hostKind: input.hostKind,
    appLocalKind: null,
    globalEntry: null,
  };
}

function hostEntry(input: {
  readonly id: string;
  readonly updatedAt: number;
  readonly readAt: number | null;
  readonly kind: HostNotificationEntry["kind"];
}): HostNotificationEntry {
  return {
    id: input.id,
    updatedAt: input.updatedAt,
    readAt: input.readAt,
    kind: input.kind,
    sourceRef: input.id,
    payload: {
      epicId: "epic-1",
      chatId: "chat-1",
      agentName: "Agent",
    },
  };
}

function appLocalRow(input: {
  readonly id: string;
  readonly createdAt: number;
  readonly readAt: number | null;
  readonly text: string;
}): NotificationEmissionRow {
  return {
    feedId: `app-local:${input.id}`,
    source: "app-local",
    sourceId: input.id,
    createdAt: input.createdAt,
    readAt: input.readAt,
    text: input.text,
    payload: null,
    hostKind: null,
    appLocalKind: "host.error",
    globalEntry: null,
  };
}

function globalRow(input: {
  readonly id: string;
  readonly createdAt: number;
  readonly readAt: number | null;
}): NotificationEmissionRow {
  return {
    feedId: `global:${input.id}`,
    source: "global",
    sourceId: input.id,
    createdAt: input.createdAt,
    readAt: input.readAt,
    text: "Global event",
    payload: { kind: "epic", epicId: "epic-1" },
    hostKind: null,
    appLocalKind: null,
    globalEntry: null,
  };
}

const ACCEPT_ALL = () => true;
const SUPPRESS_NONE = () => false;

describe("notification demux", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __resetHostNotificationsStoreForTests();
    useSettingsStore.setState({ notifyOnChatTurnComplete: true });
    useNotificationsPopoverStore.getState().setOpen(false);
  });

  it("baselines host snapshots and emits only later live host upserts", () => {
    const clock = new FakeClock();
    const emissions: ReadonlyArray<NotificationEmissionRow>[] = [];
    const demux = createNotificationDemux({
      holdMs: 1_000,
      clock,
      channels: [
        {
          id: "host",
          accepts: (row) => row.source === "host",
          emit: (rows) => {
            emissions.push(rows);
          },
        },
      ],
      getRows: readNotificationEmissionRows,
      shouldSuppressForFocus: SUPPRESS_NONE,
    });
    const unsubscribe = subscribeNotificationEmissionSources(demux);

    useHostNotificationsStore.getState().replaceFromSnapshot(
      [
        hostEntry({
          id: "snapshot-1",
          updatedAt: 10,
          readAt: null,
          kind: "agent.stopped",
        }),
        hostEntry({
          id: "snapshot-2",
          updatedAt: 20,
          readAt: null,
          kind: "approval.requested",
        }),
      ],
      50,
    );
    clock.advanceBy(1_000);

    expect(emissions).toEqual([]);

    useHostNotificationsStore.getState().upsert(
      hostEntry({
        id: "live-1",
        updatedAt: 30,
        readAt: null,
        kind: "interview.requested",
      }),
    );
    clock.advanceBy(1_000);

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.map((row) => row.feedId)).toEqual(["host:live-1"]);

    useHostNotificationsStore.getState().replaceFromSnapshot(
      [
        hostEntry({
          id: "snapshot-1",
          updatedAt: 10,
          readAt: null,
          kind: "agent.stopped",
        }),
        hostEntry({
          id: "live-1",
          updatedAt: 30,
          readAt: null,
          kind: "interview.requested",
        }),
        hostEntry({
          id: "reconnect-1",
          updatedAt: 40,
          readAt: null,
          kind: "approval.requested",
        }),
      ],
      50,
    );
    clock.advanceBy(1_000);

    expect(emissions).toHaveLength(1);

    unsubscribe();
    demux.dispose();
  });

  it("cancels a pending emission when the notification goes read during the grace window", () => {
    const harness = createHarness({
      accepts: ACCEPT_ALL,
      shouldSuppressForFocus: SUPPRESS_NONE,
    });
    harness.rows = [
      hostRow({
        id: "approval-1",
        createdAt: 10,
        readAt: null,
        hostKind: "approval.requested",
        text: "Approval requested",
        payload: null,
      }),
    ];
    observe(harness.demux, harness.rows);

    harness.rows = [
      hostRow({
        id: "approval-1",
        createdAt: 10,
        readAt: 20,
        hostKind: "approval.requested",
        text: "Approval requested",
        payload: null,
      }),
    ];
    observe(harness.demux, harness.rows);
    harness.clock.advanceBy(1_000);

    expect(harness.emissions).toEqual([]);
  });

  it("refreshes a pending upsert without duplicating the eventual emission", () => {
    const harness = createHarness({
      accepts: ACCEPT_ALL,
      shouldSuppressForFocus: SUPPRESS_NONE,
    });
    harness.rows = [
      hostRow({
        id: "agent-1",
        createdAt: 10,
        readAt: null,
        hostKind: "agent.stopped",
        text: "Agent finished",
        payload: null,
      }),
    ];
    observe(harness.demux, harness.rows);
    harness.clock.advanceBy(500);

    harness.rows = [
      hostRow({
        id: "agent-1",
        createdAt: 20,
        readAt: null,
        hostKind: "agent.stopped",
        text: "Agent finished again",
        payload: null,
      }),
    ];
    observe(harness.demux, harness.rows);
    harness.clock.advanceBy(999);

    expect(harness.emissions).toEqual([]);

    harness.clock.advanceBy(1);

    expect(harness.emissions).toHaveLength(1);
    expect(harness.emissions[0]?.map((row) => row.text)).toEqual([
      "Agent finished again",
    ]);
  });

  it("coalesces a burst into one emission and resolves content at fire time", () => {
    const harness = createHarness({
      accepts: ACCEPT_ALL,
      shouldSuppressForFocus: SUPPRESS_NONE,
    });
    harness.rows = [
      hostRow({
        id: "approval-1",
        createdAt: 10,
        readAt: null,
        hostKind: "approval.requested",
        text: "Old approval text",
        payload: null,
      }),
    ];
    observe(harness.demux, harness.rows);
    harness.clock.advanceBy(500);

    harness.rows = [
      hostRow({
        id: "approval-1",
        createdAt: 10,
        readAt: null,
        hostKind: "approval.requested",
        text: "Fresh approval text",
        payload: null,
      }),
      appLocalRow({
        id: "host-error-1",
        createdAt: 20,
        readAt: null,
        text: "Host error",
      }),
    ];
    observe(harness.demux, harness.rows);
    harness.clock.advanceBy(1_000);

    expect(harness.emissions).toHaveLength(1);
    expect(harness.emissions[0]?.map((row) => row.text)).toEqual([
      "Fresh approval text",
      "Host error",
    ]);
  });

  it("suppresses a row when the focus gate rejects it", () => {
    const harness = createHarness({
      accepts: ACCEPT_ALL,
      shouldSuppressForFocus: (row) => row.sourceId === "focused",
    });
    harness.rows = [
      hostRow({
        id: "focused",
        createdAt: 10,
        readAt: null,
        hostKind: "interview.requested",
        text: "Question waiting",
        payload: null,
      }),
    ];
    observe(harness.demux, harness.rows);
    harness.clock.advanceBy(1_000);

    expect(harness.emissions).toEqual([]);
  });

  it("applies per-channel kind filtering", () => {
    const clock = new FakeClock();
    let rows: ReadonlyArray<NotificationEmissionRow> = [];
    const hostEmissions: ReadonlyArray<NotificationEmissionRow>[] = [];
    const appLocalEmissions: ReadonlyArray<NotificationEmissionRow>[] = [];
    const demux = createNotificationDemux({
      holdMs: 1_000,
      clock,
      getRows: () => rows,
      shouldSuppressForFocus: SUPPRESS_NONE,
      channels: [
        {
          id: "host-only",
          accepts: (row) => row.hostKind === "approval.requested",
          emit: (emittedRows) => {
            hostEmissions.push(emittedRows);
          },
        },
        {
          id: "app-local-only",
          accepts: (row) => row.appLocalKind === "host.error",
          emit: (emittedRows) => {
            appLocalEmissions.push(emittedRows);
          },
        },
      ],
    });
    demux.observe(rows);
    rows = [
      hostRow({
        id: "approval-1",
        createdAt: 10,
        readAt: null,
        hostKind: "approval.requested",
        text: "Approval requested",
        payload: null,
      }),
      appLocalRow({
        id: "error-1",
        createdAt: 20,
        readAt: null,
        text: "Host error",
      }),
      globalRow({ id: "global-1", createdAt: 30, readAt: null }),
    ];
    demux.observe(rows);
    clock.advanceBy(1_000);

    expect(hostEmissions).toHaveLength(1);
    expect(hostEmissions[0]?.map((row) => row.feedId)).toEqual([
      "host:approval-1",
    ]);
    expect(appLocalEmissions).toHaveLength(1);
    expect(appLocalEmissions[0]?.map((row) => row.feedId)).toEqual([
      "app-local:error-1",
    ]);
  });

  it("suppresses agent.stopped when the turn-completion setting is disabled", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    useSettingsStore.setState({ notifyOnChatTurnComplete: false });

    expect(
      shouldSuppressNotificationEmissionForFocus(
        hostRow({
          id: "agent-1",
          createdAt: 10,
          readAt: null,
          hostKind: "agent.stopped",
          text: "Agent finished",
          payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
        }),
      ),
    ).toBe(true);
  });
});
