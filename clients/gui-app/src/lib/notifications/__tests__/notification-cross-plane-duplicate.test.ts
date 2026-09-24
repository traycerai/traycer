import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostNotificationEntrySchema,
  parseKnownHostNotificationPayloadForKind,
  type HostNotificationEntry,
  type HostNotificationsCloudFeedRow,
} from "@traycer/protocol/host/notifications/contracts";
import {
  displayCloudSnapshotArrivals,
  displayHostChannelEmission,
  resetNotificationFeedDisplayReceiptsForTests,
} from "@/lib/notifications/notification-display";
import { projectNotificationFeedDisplay } from "@traycer-clients/shared/notifications/feed-delivery";
import type { NotificationShowOutcome } from "@traycer-clients/shared/platform/runner-host";
import type { NotificationShowRequest } from "@/hooks/notifications/use-notifications";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";

interface CapturedToast {
  readonly title: unknown;
  readonly options: { readonly id: string };
}

const toastCalls = vi.hoisted((): CapturedToast[] => []);

vi.mock("sonner", () => ({
  toast: (title: unknown, options: CapturedToast["options"]): string => {
    toastCalls.push({ title, options });
    return options.id;
  },
}));

/**
 * Regression suite for the cross-plane duplicate fix, against the landed
 * `displayFeedOccurrences`/`submitFeedDisplay` in notification-display.ts.
 *
 * Identity is an occurrence key over `[userId, originHostId,
 * semantic/coalesceKey, updatedAt, sourceRef]`; the receipt set
 * (`NotificationDeliveryReceipts`, process-lifetime) and the in-flight
 * `pendingFeedOccurrences` map are both reset per test via
 * `resetNotificationFeedDisplayReceiptsForTests()`.
 *
 * `submitFeedDisplay` makes up to two shell attempts: the first request, and
 * - only on a REJECTED (thrown/IPC-failed) attempt - one retry re-filtered
 * for account/receipt/focus changes since the first attempt. If a shell
 * response resolves (any outcome, including the scalar `"duplicate"`), there
 * is no retry. If BOTH attempts reject, the caller renders one local
 * fallback toast and chimes only if THIS window is currently focused (never
 * unconditionally - otherwise every failing window would chime at once).
 * Only a structured `{kind:"feed", outcome:"undeliverable", display}`
 * response chimes unconditionally, because the shell has already elected
 * exactly one winning window for everyone else to hear `"duplicate"`.
 * `{kind:"feed", outcome:"presented", ...}` never chimes locally - the
 * native banner owns the sound.
 */
describe("cross-plane duplicate notification dedup (host emission + cloud relay)", () => {
  beforeEach(() => {
    toastCalls.length = 0;
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    resetNotificationFeedDisplayReceiptsForTests();
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "user-1", username: "user-1" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useEpicCanvasStore.setState({
      tabsById: {},
      canvasByTabId: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
    useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  });

  function cloudRowFor(
    host: HostNotificationEntry,
    durableEntryId: string,
    originHostId: string,
  ): HostNotificationsCloudFeedRow {
    return {
      entryId: durableEntryId,
      originHostId,
      coalesceKey: host.id,
      entry: { ...host, id: durableEntryId },
      presentation: { epicTitle: null, chatTitle: null },
    };
  }

  /** Default shell mock: accepts and echoes back everything it was asked to
   * show, as an `undeliverable` structured result - the one outcome that
   * chimes unconditionally, so `playChime` assertions below are deterministic
   * regardless of this test file's focus state. */
  function displayTarget() {
    return {
      showNotification: vi.fn((input: NotificationShowRequest) =>
        Promise.resolve<NotificationShowOutcome>({
          kind: "feed",
          outcome: "undeliverable",
          display: projectNotificationFeedDisplay(input.feedOccurrences ?? []),
        }),
      ),
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    };
  }

  function chatStoppedEntry(options: {
    readonly id: string;
    readonly chatId: string;
    readonly sourceRef: string;
    readonly updatedAt: number;
    readonly severity: "done" | "failure";
  }): HostNotificationEntry {
    const { id, chatId, sourceRef, updatedAt, severity } = options;
    const outcome = severity === "done" ? "completed" : "errored";
    const entry = hostNotificationEntrySchema.parse({
      id,
      updatedAt,
      readAt: null,
      kind: "agent.stopped",
      sourceRef,
      severity,
      outcome,
      epicId: "epic-1",
      chatId,
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId,
        agentName: "Agent",
        taskTitle: "Task",
        outcome,
      },
    });
    expect(
      parseKnownHostNotificationPayloadForKind(entry.kind, entry.payload),
    ).not.toBeNull();
    return entry;
  }

  const CASES = [
    {
      name: "done",
      make: () =>
        chatStoppedEntry({
          id: "agent.stopped:agent-1",
          chatId: "chat-1",
          sourceRef: "agent-1",
          updatedAt: 10,
          severity: "done",
        }),
    },
    {
      name: "failure",
      make: () =>
        chatStoppedEntry({
          id: "agent.failed:agent-1:10",
          chatId: "chat-1",
          sourceRef: "agent-1",
          updatedAt: 10,
          severity: "failure",
        }),
    },
    {
      name: "needs_action",
      make: (): HostNotificationEntry => {
        const entry = hostNotificationEntrySchema.parse({
          id: "approval.requested:chat-1",
          updatedAt: 10,
          readAt: null,
          kind: "approval.requested",
          sourceRef: "approval-1",
          severity: "needs_action",
          outcome: null,
          resolvedAt: null,
          epicId: "epic-1",
          chatId: "chat-1",
          payload: {
            kind: "approval",
            epicId: "epic-1",
            chatId: "chat-1",
            chatTitle: "Agent",
            taskTitle: "Task",
            approvalId: "approval-1",
          },
        });
        expect(
          parseKnownHostNotificationPayloadForKind(entry.kind, entry.payload),
        ).not.toBeNull();
        return entry;
      },
    },
  ];

  const ORDERS = ["host-first", "cloud-first"] as const;

  for (const order of ORDERS) {
    it.each(CASES)(
      `collapses a $name occurrence into one display (${order})`,
      async ({ make }) => {
        const originHostId = "host-A";
        const host = make();
        const cloud = cloudRowFor(host, `durable-${host.id}`, originHostId);
        const target = displayTarget();

        if (order === "host-first") {
          await displayHostChannelEmission([host], target, originHostId);
          await displayCloudSnapshotArrivals([cloud], target);
        } else {
          await displayCloudSnapshotArrivals([cloud], target);
          await displayHostChannelEmission([host], target, originHostId);
        }

        expect(target.showNotification).toHaveBeenCalledOnce();
        expect(toastCalls).toHaveLength(1);
        expect(target.playChime).toHaveBeenCalledOnce();
      },
    );
  }

  it("dedupes a late cloud snapshot replaying an occurrence already delivered while cloud was disconnected", async () => {
    const originHostId = "host-A";
    const host = chatStoppedEntry({
      id: "agent.stopped:agent-1",
      chatId: "chat-1",
      sourceRef: "agent-1",
      updatedAt: 10,
      severity: "done",
    });
    const target = displayTarget();

    await displayHostChannelEmission([host], target, originHostId);
    expect(target.showNotification).toHaveBeenCalledOnce();

    await displayCloudSnapshotArrivals(
      [cloudRowFor(host, "durable-recovered", originHostId)],
      target,
    );

    expect(target.showNotification).toHaveBeenCalledOnce();
    expect(toastCalls).toHaveLength(1);
    expect(target.playChime).toHaveBeenCalledOnce();
  });

  it("a reload (receipt reset) still relies on the shell's own duplicate answer to avoid a second display", async () => {
    // The renderer's receipt set is process-lifetime, not persisted - a
    // reload clears it. But the shell/main process keeps its own ledger
    // across that reload, and reports the retry as a duplicate, so nothing
    // renders twice even though this renderer's own memory was wiped.
    const originHostId = "host-A";
    const host = chatStoppedEntry({
      id: "agent.stopped:agent-1",
      chatId: "chat-1",
      sourceRef: "agent-1",
      updatedAt: 10,
      severity: "done",
    });
    const target = displayTarget();

    await displayHostChannelEmission([host], target, originHostId);
    expect(toastCalls).toHaveLength(1);

    resetNotificationFeedDisplayReceiptsForTests();

    const dupTarget = {
      showNotification: vi.fn(() =>
        Promise.resolve<NotificationShowOutcome>("duplicate"),
      ),
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    };
    await displayCloudSnapshotArrivals(
      [cloudRowFor(host, "durable-after-reload", originHostId)],
      dupTarget,
    );

    expect(toastCalls).toHaveLength(1);
    expect(dupTarget.playChime).not.toHaveBeenCalled();
  });

  it("shows nothing when the shell reports the request as an outright duplicate", async () => {
    const originHostId = "host-A";
    const host = chatStoppedEntry({
      id: "agent.stopped:agent-1",
      chatId: "chat-1",
      sourceRef: "agent-1",
      updatedAt: 10,
      severity: "done",
    });
    const target = {
      showNotification: vi.fn(() =>
        Promise.resolve<NotificationShowOutcome>("duplicate"),
      ),
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    };

    await displayHostChannelEmission([host], target, originHostId);

    expect(toastCalls).toHaveLength(0);
    expect(target.playChime).not.toHaveBeenCalled();
  });

  it("recovers via its own internal retry: a host attempt that rejects once then succeeds renders exactly once", async () => {
    const originHostId = "host-A";
    const host = chatStoppedEntry({
      id: "agent.stopped:agent-1",
      chatId: "chat-1",
      sourceRef: "agent-1",
      updatedAt: 10,
      severity: "done",
    });
    const showNotification = vi
      .fn()
      .mockRejectedValueOnce(new Error("ipc failure"))
      .mockImplementation((input: NotificationShowRequest) =>
        Promise.resolve<NotificationShowOutcome>({
          kind: "feed",
          outcome: "undeliverable",
          display: projectNotificationFeedDisplay(input.feedOccurrences ?? []),
        }),
      );
    const target = {
      showNotification,
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    };

    await displayHostChannelEmission([host], target, originHostId);

    expect(showNotification).toHaveBeenCalledTimes(2);
    expect(toastCalls).toHaveLength(1);
    expect(target.playChime).toHaveBeenCalledOnce();
  });

  it("recovers via its own internal retry: a remote cloud arrival that rejects once then succeeds renders exactly once", async () => {
    const originHostId = "host-B";
    const host = chatStoppedEntry({
      id: "agent.stopped:agent-1",
      chatId: "chat-1",
      sourceRef: "agent-1",
      updatedAt: 10,
      severity: "done",
    });
    const showNotification = vi
      .fn()
      .mockRejectedValueOnce(new Error("ipc failure"))
      .mockImplementation((input: NotificationShowRequest) =>
        Promise.resolve<NotificationShowOutcome>({
          kind: "feed",
          outcome: "undeliverable",
          display: projectNotificationFeedDisplay(input.feedOccurrences ?? []),
        }),
      );
    const target = {
      showNotification,
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    };

    await displayCloudSnapshotArrivals(
      [cloudRowFor(host, "durable-remote", originHostId)],
      target,
    );

    expect(showNotification).toHaveBeenCalledTimes(2);
    expect(toastCalls).toHaveLength(1);
    expect(target.playChime).toHaveBeenCalledOnce();
  });

  it("falls back to one local toast+chime when both attempts reject, and the other feed does not duplicate it", async () => {
    const originHostId = "host-A";
    const host = chatStoppedEntry({
      id: "agent.stopped:agent-1",
      chatId: "chat-1",
      sourceRef: "agent-1",
      updatedAt: 10,
      severity: "done",
    });
    const failingTarget = {
      showNotification: vi.fn(() => Promise.reject(new Error("ipc failure"))),
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    };

    // Focused, so the local fallback (gated on focus, never unconditional)
    // is the one voice here.
    await displayHostChannelEmission([host], failingTarget, originHostId);

    expect(failingTarget.showNotification).toHaveBeenCalledTimes(2);
    expect(toastCalls).toHaveLength(1);
    expect(failingTarget.playChime).toHaveBeenCalledOnce();

    // The cloud lane's arrival for the SAME occurrence finds the receipt the
    // local fallback already claimed and renders nothing new.
    const cloudTarget = displayTarget();
    await displayCloudSnapshotArrivals(
      [cloudRowFor(host, "durable-after-fallback", originHostId)],
      cloudTarget,
    );

    expect(toastCalls).toHaveLength(1);
    expect(cloudTarget.showNotification).not.toHaveBeenCalled();
    expect(cloudTarget.playChime).not.toHaveBeenCalled();
  });

  it("coalesces a cloud arrival that waits out a host attempt which itself falls back to one toast+chime", async () => {
    // The pending map makes an overlapping cloud arrival WAIT on the host
    // attempt already in flight for the same occurrence, rather than firing
    // its own request. By the time it resumes, the host side has already
    // exhausted both its own attempts, rendered the local fallback, and
    // claimed the receipt - so the cloud side finds nothing left to submit.
    const originHostId = "host-A";
    const host = chatStoppedEntry({
      id: "agent.stopped:agent-1",
      chatId: "chat-1",
      sourceRef: "agent-1",
      updatedAt: 10,
      severity: "done",
    });

    let rejectHostFirstAttempt: (error: Error) => void = () => {};
    const firstAttempt = new Promise<NotificationShowOutcome>(
      (_resolve, reject) => {
        rejectHostFirstAttempt = reject;
      },
    );
    const hostShow = vi.fn(() =>
      Promise.reject<NotificationShowOutcome>(new Error("ipc failure")),
    );
    hostShow.mockImplementationOnce(() => firstAttempt);
    const hostTarget = {
      showNotification: hostShow,
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    };

    const hostCall = displayHostChannelEmission(
      [host],
      hostTarget,
      originHostId,
    );

    const cloudTarget = displayTarget();
    const cloudCall = displayCloudSnapshotArrivals(
      [cloudRowFor(host, "durable-pending", originHostId)],
      cloudTarget,
    );

    rejectHostFirstAttempt(new Error("ipc failure"));
    await hostCall;
    await cloudCall;

    expect(toastCalls).toHaveLength(1);
    expect(hostTarget.playChime).toHaveBeenCalledOnce();
    expect(cloudTarget.showNotification).not.toHaveBeenCalled();
    expect(cloudTarget.playChime).not.toHaveBeenCalled();
  });

  it("renders only the accepted subset when the shell filters a requested batch", async () => {
    const originHostId = "host-A";
    const a = chatStoppedEntry({
      id: "agent.stopped:agent-A",
      chatId: "chat-A",
      sourceRef: "agent-A",
      updatedAt: 10,
      severity: "done",
    });
    const b = chatStoppedEntry({
      id: "agent.stopped:agent-B",
      chatId: "chat-B",
      sourceRef: "agent-B",
      updatedAt: 10,
      severity: "done",
    });
    const target = {
      showNotification: vi.fn((input: NotificationShowRequest) =>
        Promise.resolve<NotificationShowOutcome>({
          kind: "feed",
          outcome: "undeliverable",
          display: projectNotificationFeedDisplay(
            (input.feedOccurrences ?? []).filter(
              (occurrence) => occurrence.replaceKey === "host:chat:chat-B",
            ),
          ),
        }),
      ),
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    };

    await displayHostChannelEmission([a, b], target, originHostId);

    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0]?.options.id).toBe("host:chat:chat-B");
  });

  it("still displays two entries sharing a timestamp but distinct sourceRefs (same-millisecond supersede)", async () => {
    const originHostId = "host-A";
    const first = chatStoppedEntry({
      id: "agent.stopped:agent-1",
      chatId: "chat-1",
      sourceRef: "approval-1",
      updatedAt: 10,
      severity: "done",
    });
    const second = chatStoppedEntry({
      id: "agent.stopped:agent-1",
      chatId: "chat-1",
      sourceRef: "approval-2",
      updatedAt: 10,
      severity: "done",
    });
    const target = displayTarget();

    await displayHostChannelEmission([first], target, originHostId);
    await displayCloudSnapshotArrivals(
      [cloudRowFor(second, "durable-second", originHostId)],
      target,
    );

    expect(target.showNotification).toHaveBeenCalledTimes(2);
  });

  it("still displays the same coalesceKey/sourceRef/timestamp arriving from a different origin host", async () => {
    const hostA = chatStoppedEntry({
      id: "agent.stopped:agent-1",
      chatId: "chat-1",
      sourceRef: "agent-1",
      updatedAt: 10,
      severity: "done",
    });
    const hostB = chatStoppedEntry({
      id: "agent.stopped:agent-1",
      chatId: "chat-1",
      sourceRef: "agent-1",
      updatedAt: 10,
      severity: "done",
    });
    const target = displayTarget();

    await displayHostChannelEmission([hostA], target, "host-A");
    await displayCloudSnapshotArrivals(
      [cloudRowFor(hostB, "durable-remote", "host-B")],
      target,
    );

    expect(target.showNotification).toHaveBeenCalledTimes(2);
  });

  it("does not poison the dedup receipt when the host row was suppressed by focus", async () => {
    const originHostId = "host-A";
    const host = chatStoppedEntry({
      id: "agent.stopped:agent-1",
      chatId: "chat-1",
      sourceRef: "agent-1",
      updatedAt: 10,
      severity: "done",
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");
    useEpicCanvasStore.getState().openTileInTab(
      tabId,
      makeOpenableNodeRef({
        id: "chat-1",
        instanceId: "chat-1-instance",
        type: "chat",
        name: "Chat",
        hostId: originHostId,
      }),
    );
    const target = displayTarget();

    await displayHostChannelEmission([host], target, originHostId);
    expect(target.showNotification).not.toHaveBeenCalled();

    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await displayCloudSnapshotArrivals(
      [cloudRowFor(host, "durable-1", originHostId)],
      target,
    );

    expect(target.showNotification).toHaveBeenCalledOnce();
  });

  it("does not render a pending submission whose account changed while it was in flight", async () => {
    const originHostId = "host-A";
    const host = chatStoppedEntry({
      id: "agent.stopped:agent-1",
      chatId: "chat-1",
      sourceRef: "agent-1",
      updatedAt: 10,
      severity: "done",
    });

    let resolveShow: (outcome: NotificationShowOutcome) => void = () => {};
    const pendingOutcome = new Promise<NotificationShowOutcome>((resolve) => {
      resolveShow = resolve;
    });
    const showNotification = vi.fn(
      (_input: NotificationShowRequest) => pendingOutcome,
    );
    const target = {
      showNotification,
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    };

    const call = displayHostChannelEmission([host], target, originHostId);

    // Account changes while the request is still in flight.
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "user-2", username: "user-2" },
    });

    // The shell honestly reports it showed the occurrence it was asked
    // about (built while account was user-1) - the account re-check at
    // claim time is what must block the render, not the shell's answer.
    const sentOccurrences =
      showNotification.mock.calls[0]?.[0]?.feedOccurrences ?? [];
    resolveShow({
      kind: "feed",
      outcome: "undeliverable",
      display: projectNotificationFeedDisplay(sentOccurrences),
    });
    await call;

    expect(toastCalls).toHaveLength(0);
    expect(target.playChime).not.toHaveBeenCalled();
  });

  it("does not resubmit a queued cloud arrival after its pending host attempt failed during an account change", async () => {
    const originHostId = "host-A";
    const host = chatStoppedEntry({
      id: "agent.stopped:agent-1",
      chatId: "chat-1",
      sourceRef: "agent-1",
      updatedAt: 10,
      severity: "done",
    });

    let rejectHostShow: (error: Error) => void = () => {};
    const hostOutcome = new Promise<NotificationShowOutcome>(
      (_resolve, reject) => {
        rejectHostShow = reject;
      },
    );
    const hostTarget = {
      showNotification: vi.fn(() => hostOutcome),
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    };
    const hostCall = displayHostChannelEmission(
      [host],
      hostTarget,
      originHostId,
    );

    const cloudTarget = displayTarget();
    const cloudCall = displayCloudSnapshotArrivals(
      [cloudRowFor(host, "durable-pending", originHostId)],
      cloudTarget,
    );

    // Account changes while both the host attempt and the waiting cloud
    // arrival are in flight.
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "user-2", username: "user-2" },
    });
    rejectHostShow(new Error("ipc failure"));
    await hostCall;
    await cloudCall;

    // The host's retry is fenced by the account change and finds nothing
    // eligible, so it never re-submits; the cloud waiter, woken after, finds
    // the same account mismatch and never submits either.
    expect(hostTarget.showNotification).toHaveBeenCalledOnce();
    expect(cloudTarget.showNotification).not.toHaveBeenCalled();
    expect(toastCalls).toHaveLength(0);
  });

  it("batches host A/B first, then a recovered cloud snapshot for A and B shows nothing new", async () => {
    const originHostId = "host-A";
    const a = chatStoppedEntry({
      id: "agent.stopped:agent-A",
      chatId: "chat-A",
      sourceRef: "agent-A",
      updatedAt: 10,
      severity: "done",
    });
    const b = chatStoppedEntry({
      id: "agent.stopped:agent-B",
      chatId: "chat-B",
      sourceRef: "agent-B",
      updatedAt: 10,
      severity: "done",
    });
    const target = displayTarget();

    await displayHostChannelEmission([a, b], target, originHostId);
    expect(target.showNotification).toHaveBeenCalledOnce();
    expect(toastCalls).toHaveLength(1);
    expect(target.playChime).toHaveBeenCalledOnce();

    await displayCloudSnapshotArrivals(
      [
        cloudRowFor(a, "durable-a", originHostId),
        cloudRowFor(b, "durable-b", originHostId),
      ],
      target,
    );

    expect(target.showNotification).toHaveBeenCalledOnce();
    expect(toastCalls).toHaveLength(1);
    expect(target.playChime).toHaveBeenCalledOnce();
  });

  it("cloud A first, then a host batch of A/B displays only the new B", async () => {
    const originHostId = "host-A";
    const a = chatStoppedEntry({
      id: "agent.stopped:agent-A",
      chatId: "chat-A",
      sourceRef: "agent-A",
      updatedAt: 10,
      severity: "done",
    });
    const b = chatStoppedEntry({
      id: "agent.stopped:agent-B",
      chatId: "chat-B",
      sourceRef: "agent-B",
      updatedAt: 10,
      severity: "done",
    });
    const target = displayTarget();

    await displayCloudSnapshotArrivals(
      [cloudRowFor(a, "durable-a", originHostId)],
      target,
    );
    expect(target.showNotification).toHaveBeenCalledOnce();

    await displayHostChannelEmission([a, b], target, originHostId);

    expect(target.showNotification).toHaveBeenCalledTimes(2);
    expect(toastCalls).toHaveLength(2);
    expect(target.playChime).toHaveBeenCalledTimes(2);
    const secondCall = target.showNotification.mock.calls[1][0];
    expect(secondCall.title).not.toBe("Traycer");
    expect(secondCall.payload).toMatchObject({
      route: { kind: "chat", epicId: "epic-1", chatId: "chat-B" },
    });
  });

  it("control: two windows on the SAME plane still share one delivery key", async () => {
    const entries = [
      chatStoppedEntry({
        id: "agent.stopped:agent-1",
        chatId: "chat-1",
        sourceRef: "agent-1",
        updatedAt: 10,
        severity: "done",
      }),
    ];

    const windowA = displayTarget();
    await displayHostChannelEmission(entries, windowA, "host-A");

    resetNotificationFeedDisplayReceiptsForTests();
    const windowB = displayTarget();
    await displayHostChannelEmission(entries, windowB, "host-A");

    expect(windowA.showNotification.mock.calls[0][0].deliveryKey).toBe(
      windowB.showNotification.mock.calls[0][0].deliveryKey,
    );
  });
});
