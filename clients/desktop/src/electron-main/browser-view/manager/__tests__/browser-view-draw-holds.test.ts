import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserViewNativeTabCapability } from "@traycer-clients/shared/platform/browser-view";
import { RunnerHostEvent } from "../../../../ipc-contracts/ipc-channels";
import { FakeWebContents } from "../../debug/__tests__/browser-debug-session-test-support";
import { BrowserViewDrawHolds } from "../browser-view-draw-holds";
import type { BrowserViewEntry } from "../browser-view-entry";
import { NativeBrowserViewLifecycle } from "../native-browser-view-lifecycle";

const WINDOW = "window-1";
const REGISTRATION = "registration-1";

function createEntry(
  windowId: string,
  registrationId: string,
): BrowserViewEntry {
  const capability: BrowserViewNativeTabCapability = {
    hostId: "host-1",
    sessionId: "session-1",
    tabId: `tab-${registrationId}`,
    registrationId,
  };
  const lifecycle = new NativeBrowserViewLifecycle();
  lifecycle.completeProvisioning(capability, null);
  lifecycle.accept();
  return {
    surface: {
      windowId,
      viewTabId: "view-tab-1",
      paneId: "pane-1",
      tileInstanceId: "tile-1",
      pageSessionId: "page-1",
    },
    surfaceBindingId: "binding-1",
    guestKey: `guest-${registrationId}`,
    identity: {
      key: capability,
      ...capability,
      lifecycleWindowId: windowId,
      lifecycle,
    },
    profile: "primary",
    webContents: new FakeWebContents(),
    listeners: {},
    desiredVisible: true,
    requestedUrl: "https://example.test/",
    currentUrl: "https://example.test/",
    currentTitle: "Example",
    status: "ready",
    statusReason: null,
    navigationAttempt: 0,
    findState: {
      appRequestId: 0,
      query: "",
      matchCase: false,
      sessionsByElectronRequestId: new Map(),
    },
    certificateError: null,
    debugSession: null,
    seedLease: null,
    agentCdpLease: null,
    annotationSession: null,
    devToolsWindow: null,
    rendererResetPending: false,
    internalNavigation: false,
    succeededByReplacement: false,
    closePromise: null,
  };
}

interface SentEvent {
  readonly windowId: string;
  readonly channel: string;
  readonly holdId: string;
  readonly registrationId: string;
}

function createHolds(sendResult: boolean): {
  readonly holds: BrowserViewDrawHolds;
  readonly sent: SentEvent[];
} {
  const sent: SentEvent[] = [];
  const holds = new BrowserViewDrawHolds((windowId, channel, payload) => {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("holdId" in payload) ||
      typeof payload.holdId !== "string" ||
      !("registrationId" in payload) ||
      typeof payload.registrationId !== "string"
    ) {
      throw new Error("unexpected draw-hold payload");
    }
    sent.push({
      windowId,
      channel,
      holdId: payload.holdId,
      registrationId: payload.registrationId,
    });
    return sendResult;
  });
  return { holds, sent };
}

function requestedHold(sent: readonly SentEvent[]): SentEvent {
  const request = sent.find(
    (event) =>
      event.channel === RunnerHostEvent.browserViewGuestDrawHoldRequested,
  );
  if (request === undefined) throw new Error("expected a hold request");
  return request;
}

/** Whether `ready` has settled, without waiting for it to. */
async function settled(ready: Promise<void>): Promise<boolean> {
  let done = false;
  void ready.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserViewDrawHolds", () => {
  it("sends one request for overlapping holds and one release on the last release", () => {
    const { holds, sent } = createHolds(true);
    const entry = createEntry(WINDOW, REGISTRATION);

    const first = holds.hold(entry);
    const second = holds.hold(entry);
    expect(sent.map((event) => event.channel)).toEqual([
      RunnerHostEvent.browserViewGuestDrawHoldRequested,
    ]);
    expect(sent[0]).toMatchObject({
      windowId: WINDOW,
      registrationId: REGISTRATION,
    });

    first.release();
    expect(sent).toHaveLength(1);

    second.release();
    expect(sent.map((event) => event.channel)).toEqual([
      RunnerHostEvent.browserViewGuestDrawHoldRequested,
      RunnerHostEvent.browserViewGuestDrawHoldReleased,
    ]);
    expect(sent[1]?.holdId).toBe(sent[0]?.holdId);
    expect(sent[1]).toMatchObject({
      windowId: WINDOW,
      registrationId: REGISTRATION,
    });
  });

  it("counts a repeated release once and opens a fresh hold afterwards", () => {
    const { holds, sent } = createHolds(true);
    const entry = createEntry(WINDOW, REGISTRATION);
    const first = holds.hold(entry);
    const second = holds.hold(entry);

    first.release();
    first.release();
    expect(sent).toHaveLength(1);

    second.release();
    second.release();
    expect(sent).toHaveLength(2);

    holds.hold(entry);
    expect(sent).toHaveLength(3);
    expect(sent[2]?.channel).toBe(
      RunnerHostEvent.browserViewGuestDrawHoldRequested,
    );
    expect(sent[2]?.holdId).not.toBe(sent[0]?.holdId);
  });

  it("settles ready on a matching acknowledgement only", async () => {
    const { holds, sent } = createHolds(true);
    const entry = createEntry(WINDOW, REGISTRATION);
    const hold = holds.hold(entry);
    const { holdId } = requestedHold(sent);

    holds.reportApplied("window-2", {
      holdId,
      registrationId: REGISTRATION,
      applied: true,
    });
    holds.reportApplied(WINDOW, {
      holdId: "other-hold",
      registrationId: REGISTRATION,
      applied: true,
    });
    holds.reportApplied(WINDOW, {
      holdId,
      registrationId: "other-registration",
      applied: true,
    });
    expect(await settled(hold.ready)).toBe(false);

    holds.reportApplied(WINDOW, {
      holdId,
      registrationId: REGISTRATION,
      applied: true,
    });
    expect(await settled(hold.ready)).toBe(true);
  });

  it("settles ready at the deadline when no acknowledgement arrives", async () => {
    vi.useFakeTimers();
    const { holds } = createHolds(true);
    const hold = holds.hold(createEntry(WINDOW, REGISTRATION));

    await vi.advanceTimersByTimeAsync(999);
    expect(await settled(hold.ready)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(hold.ready)).toBe(true);
  });

  it("settles ready at once when the request could not be sent", async () => {
    const { holds } = createHolds(false);
    const hold = holds.hold(createEntry(WINDOW, REGISTRATION));

    expect(await settled(hold.ready)).toBe(true);
  });

  it("settles waiters on forget and sends no release afterwards", async () => {
    const { holds, sent } = createHolds(true);
    const entry = createEntry(WINDOW, REGISTRATION);
    const hold = holds.hold(entry);
    expect(await settled(hold.ready)).toBe(false);

    holds.forget(entry);
    expect(await settled(hold.ready)).toBe(true);

    hold.release();
    expect(sent.map((event) => event.channel)).toEqual([
      RunnerHostEvent.browserViewGuestDrawHoldRequested,
    ]);
  });

  it("keeps holds of different guests apart", () => {
    const { holds, sent } = createHolds(true);
    const entryA = createEntry(WINDOW, "registration-a");
    const entryB = createEntry("window-2", "registration-b");

    const holdA = holds.hold(entryA);
    holds.hold(entryB);
    expect(sent.map((event) => event.registrationId)).toEqual([
      "registration-a",
      "registration-b",
    ]);
    expect(sent[1]?.windowId).toBe("window-2");

    holdA.release();
    expect(sent[2]).toMatchObject({
      channel: RunnerHostEvent.browserViewGuestDrawHoldReleased,
      registrationId: "registration-a",
    });
  });

  describe("withHold", () => {
    it("reads after the guest is drawn, returns the value and releases", async () => {
      const { holds, sent } = createHolds(true);
      const entry = createEntry(WINDOW, REGISTRATION);
      const read = vi.fn(() => Promise.resolve("pixels"));

      const result = holds.withHold(entry, read);
      await Promise.resolve();
      expect(read).not.toHaveBeenCalled();

      holds.reportApplied(WINDOW, {
        holdId: requestedHold(sent).holdId,
        registrationId: REGISTRATION,
        applied: true,
      });

      await expect(result).resolves.toBe("pixels");
      expect(read).toHaveBeenCalledTimes(1);
      expect(sent.at(-1)?.channel).toBe(
        RunnerHostEvent.browserViewGuestDrawHoldReleased,
      );
    });

    it("releases when the read throws", async () => {
      const { holds, sent } = createHolds(false);
      const entry = createEntry(WINDOW, REGISTRATION);

      await expect(
        holds.withHold(entry, () =>
          Promise.reject(new Error("capture failed")),
        ),
      ).rejects.toThrow("capture failed");

      expect(sent.map((event) => event.channel)).toEqual([
        RunnerHostEvent.browserViewGuestDrawHoldRequested,
        RunnerHostEvent.browserViewGuestDrawHoldReleased,
      ]);
    });
  });
});
