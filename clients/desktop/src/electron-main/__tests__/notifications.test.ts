import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type NotificationEventName = "close" | "click";

class FakeNotification {
  static supported = true;
  static instances: FakeNotification[] = [];
  static constructed: Array<{ readonly title: string; readonly body: string }> =
    [];

  readonly close = vi.fn();
  readonly show = vi.fn();
  private readonly listeners = new Map<
    NotificationEventName,
    Array<() => void>
  >();

  constructor(options: { readonly title: string; readonly body: string }) {
    FakeNotification.constructed.push({
      title: options.title,
      body: options.body,
    });
    FakeNotification.instances.push(this);
  }

  static isSupported(): boolean {
    return FakeNotification.supported;
  }

  on(event: NotificationEventName, listener: () => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: NotificationEventName): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

class FakeBrowserWindow {
  static windows: Array<{
    readonly destroyed: boolean;
    readonly focused: boolean;
  }> = [];

  static getAllWindows() {
    return FakeBrowserWindow.windows.map((window) => ({
      isDestroyed: () => window.destroyed,
      isFocused: () => window.focused,
    }));
  }
}

vi.mock("electron", () => ({
  BrowserWindow: FakeBrowserWindow,
  Notification: FakeNotification,
}));

vi.mock("../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

beforeEach(() => {
  FakeBrowserWindow.windows = [];
  FakeNotification.supported = true;
  FakeNotification.instances = [];
  FakeNotification.constructed = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.resetModules();
});

async function loadNotifications() {
  return import("../notifications");
}

function showOptions(replaceKey: string) {
  return {
    title: "Traycer",
    body: "Agent finished",
    replaceKey,
    deliveryKey: null,
    onClick: null,
    onForegroundSuppressed: null,
  };
}

describe("showNativeNotification", () => {
  it("suppresses the OS notification when any live Traycer window is focused", async () => {
    const { showNativeNotification } = await loadNotifications();
    const onForegroundSuppressed = vi.fn();
    FakeBrowserWindow.windows = [
      { destroyed: false, focused: false },
      { destroyed: false, focused: true },
    ];

    showNativeNotification({
      ...showOptions("host:chat:chat-1"),
      onForegroundSuppressed,
    });

    expect(FakeNotification.instances).toHaveLength(0);
    expect(onForegroundSuppressed).toHaveBeenCalledOnce();
  });

  it("does not replay a foreground-suppressed delivery after the app loses focus", async () => {
    const { showNativeNotification } = await loadNotifications();
    const options = {
      ...showOptions("host:chat:chat-1"),
      deliveryKey: "user-1:notification-1:10",
    };
    FakeBrowserWindow.windows = [{ destroyed: false, focused: true }];
    showNativeNotification(options);

    FakeBrowserWindow.windows = [{ destroyed: false, focused: false }];
    showNativeNotification(options);

    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("does not commit an exact delivery key when the foreground relay fails", async () => {
    const { showNativeNotification } = await loadNotifications();
    const options = {
      ...showOptions("host:chat:chat-1"),
      deliveryKey: "user-1:notification-1:10",
      onForegroundSuppressed: () => {
        throw new Error("focused renderer unavailable");
      },
    };
    FakeBrowserWindow.windows = [{ destroyed: false, focused: true }];

    expect(() => showNativeNotification(options)).toThrow(
      "focused renderer unavailable",
    );

    FakeBrowserWindow.windows = [{ destroyed: false, focused: false }];
    showNativeNotification({
      ...options,
      onForegroundSuppressed: null,
    });

    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]?.show).toHaveBeenCalledOnce();
  });

  it("closes a stale same-key notification when its replacement is foreground-suppressed", async () => {
    const { showNativeNotification } = await loadNotifications();
    showNativeNotification(showOptions("host:chat:chat-1"));
    const stale = FakeNotification.instances[0];

    FakeBrowserWindow.windows = [{ destroyed: false, focused: true }];
    showNativeNotification(showOptions("host:chat:chat-1"));

    expect(stale.close).toHaveBeenCalledOnce();
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("shows the OS notification when no live Traycer window is focused", async () => {
    const { showNativeNotification } = await loadNotifications();
    FakeBrowserWindow.windows = [
      { destroyed: false, focused: false },
      { destroyed: true, focused: true },
    ];

    showNativeNotification(showOptions("host:chat:chat-1"));

    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]?.show).toHaveBeenCalledOnce();
  });

  it("closes the prior notification before showing a same-key replacement", async () => {
    const { showNativeNotification } = await loadNotifications();

    showNativeNotification(showOptions("host:chat:chat-1"));
    const first = FakeNotification.instances[0];
    showNativeNotification(showOptions("host:chat:chat-1"));
    const second = FakeNotification.instances[1];

    expect(first.close).toHaveBeenCalledOnce();
    expect(second.show).toHaveBeenCalledOnce();
  });

  it("does not let a delayed close from the replaced notification drop its replacement", async () => {
    const { showNativeNotification } = await loadNotifications();

    showNativeNotification(showOptions("host:chat:chat-1"));
    const first = FakeNotification.instances[0];
    showNativeNotification(showOptions("host:chat:chat-1"));
    const second = FakeNotification.instances[1];
    first.emit("close");
    showNativeNotification(showOptions("host:chat:chat-1"));

    expect(second.close).toHaveBeenCalledOnce();
  });

  it("keeps a replacement mapped after an old notification clicks then closes", async () => {
    const { showNativeNotification } = await loadNotifications();

    showNativeNotification(showOptions("host:chat:chat-1"));
    const first = FakeNotification.instances[0];
    first.emit("click");
    showNativeNotification(showOptions("host:chat:chat-1"));
    const second = FakeNotification.instances[1];
    first.emit("close");
    showNativeNotification(showOptions("host:chat:chat-1"));

    expect(first.close).not.toHaveBeenCalled();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it("closes an aged notification when its same-key replacement is foreground-suppressed", async () => {
    const { showNativeNotification } = await loadNotifications();

    showNativeNotification(showOptions("host:chat:chat-1"));
    const first = FakeNotification.instances[0];
    vi.advanceTimersByTime(10 * 60_000);
    FakeBrowserWindow.windows = [{ destroyed: false, focused: true }];
    showNativeNotification(showOptions("host:chat:chat-1"));

    expect(first.close).toHaveBeenCalledOnce();
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("evicts capacity bookkeeping without closing unrelated notifications", async () => {
    const { showNativeNotification } = await loadNotifications();

    for (let index = 0; index < 100; index += 1) {
      showNativeNotification(showOptions(`host:chat:chat-${index}`));
    }
    const first = FakeNotification.instances[0];
    showNativeNotification(showOptions("host:chat:chat-100"));
    showNativeNotification(showOptions("host:chat:chat-0"));

    expect(first.close).not.toHaveBeenCalled();
  });

  it("collapses concurrent displays from separate windows by replacement key", async () => {
    const { showNativeNotification } = await loadNotifications();

    showNativeNotification(showOptions("host:chat:chat-1"));
    const first = FakeNotification.instances[0];
    showNativeNotification(showOptions("host:chat:chat-1"));

    expect(first.close).toHaveBeenCalledOnce();
    expect(FakeNotification.instances).toHaveLength(2);
  });

  it("shows an exact delivery key only once across renderer windows", async () => {
    const { showNativeNotification } = await loadNotifications();
    const options = {
      ...showOptions("host:chat:chat-1"),
      deliveryKey: "user-1:notification-1:10",
    };

    expect(showNativeNotification(options)).toBe("presented");
    expect(showNativeNotification(options)).toBe("duplicate");

    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]?.show).toHaveBeenCalledOnce();
  });

  it("reports a foreground-suppressed delivery as presented", async () => {
    const { showNativeNotification } = await loadNotifications();
    FakeBrowserWindow.windows = [{ destroyed: false, focused: true }];

    const outcome = showNativeNotification({
      ...showOptions("host:chat:chat-1"),
      onForegroundSuppressed: vi.fn(),
    });

    expect(outcome).toBe("presented");
  });

  it("reports undeliverable exactly once per key when notifications are unsupported", async () => {
    // No banner, no relay, key burnt: the single `undeliverable` answer is
    // what elects one renderer to own the fallback cue; every other window
    // hears `duplicate` and stays silent.
    const { showNativeNotification } = await loadNotifications();
    FakeNotification.supported = false;
    const options = {
      ...showOptions("host:chat:chat-1"),
      deliveryKey: "user-1:notification-1:10",
    };

    expect(showNativeNotification(options)).toBe("undeliverable");
    expect(showNativeNotification(options)).toBe("duplicate");
    expect(FakeNotification.instances).toHaveLength(0);
  });
});

function occurrence(
  key: string,
  overrides: {
    readonly feedSource?: "host" | "cloud";
    readonly replaceKey?: string;
  },
) {
  return {
    key,
    title: `title-${key}`,
    body: `body-${key}`,
    payload: { target: key },
    replaceKey: overrides.replaceKey ?? `replace-${key}`,
    feedSource: overrides.feedSource ?? ("host" as const),
    originHostId: "host-1",
    epicId: `epic-${key}`,
    chatId: `chat-${key}`,
    chimeEventType: "done" as const,
    userId: null,
  };
}

describe("showNativeFeedNotification", () => {
  it("shows one native notification for the same occurrence from host and cloud", async () => {
    const { showNativeFeedNotification } = await loadNotifications();

    const first = showNativeFeedNotification(
      [occurrence("A", { feedSource: "host" })],
      vi.fn(),
      vi.fn(),
    );
    const second = showNativeFeedNotification(
      [occurrence("A", { feedSource: "cloud" })],
      vi.fn(),
      vi.fn(),
    );

    expect(first).toMatchObject({
      kind: "feed",
      outcome: "presented",
      display: { feedOccurrences: [occurrence("A", { feedSource: "host" })] },
    });
    expect(second).toBe("duplicate");
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]?.show).toHaveBeenCalledOnce();
  });

  it("shows nothing for individual A/B after batch A/B", async () => {
    const { showNativeFeedNotification } = await loadNotifications();

    showNativeFeedNotification(
      [occurrence("A", {}), occurrence("B", {})],
      vi.fn(),
      vi.fn(),
    );
    showNativeFeedNotification([occurrence("A", {})], vi.fn(), vi.fn());
    showNativeFeedNotification([occurrence("B", {})], vi.fn(), vi.fn());

    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]?.show).toHaveBeenCalledOnce();
  });

  it("shows nothing for batch A/B after individual A/B", async () => {
    const { showNativeFeedNotification } = await loadNotifications();

    showNativeFeedNotification([occurrence("A", {})], vi.fn(), vi.fn());
    showNativeFeedNotification([occurrence("B", {})], vi.fn(), vi.fn());
    const outcome = showNativeFeedNotification(
      [occurrence("A", {}), occurrence("B", {})],
      vi.fn(),
      vi.fn(),
    );

    expect(outcome).toBe("duplicate");
    expect(FakeNotification.instances).toHaveLength(2);
  });

  it("projects only the unseen occurrence when a batch follows individual A", async () => {
    const { showNativeFeedNotification } = await loadNotifications();
    const onClick = vi.fn();

    showNativeFeedNotification([occurrence("A", {})], vi.fn(), vi.fn());
    const result = showNativeFeedNotification(
      [occurrence("A", {}), occurrence("B", {})],
      onClick,
      vi.fn(),
    );

    expect(result).toMatchObject({
      kind: "feed",
      outcome: "presented",
      display: { title: "title-B", feedOccurrences: [occurrence("B", {})] },
    });
    expect(FakeNotification.instances).toHaveLength(2);
    const second = FakeNotification.instances[1];
    expect(second?.show).toHaveBeenCalledOnce();
    expect(FakeNotification.constructed[1]).toEqual({
      title: "title-B",
      body: "body-B",
    });
    second?.emit("click");
    expect(onClick).toHaveBeenCalledWith({ target: "B" });
  });

  it("does not lose new rows in overlapping or reordered batches", async () => {
    const { showNativeFeedNotification } = await loadNotifications();
    const onClick = vi.fn();

    showNativeFeedNotification(
      [occurrence("A", {}), occurrence("B", {})],
      vi.fn(),
      vi.fn(),
    );
    const result = showNativeFeedNotification(
      [occurrence("B", {}), occurrence("A", {}), occurrence("C", {})],
      onClick,
      vi.fn(),
    );

    expect(result).toMatchObject({
      kind: "feed",
      outcome: "presented",
      display: { feedOccurrences: [occurrence("C", {})] },
    });
    expect(FakeNotification.instances).toHaveLength(2);
    expect(FakeNotification.constructed[1]).toEqual({
      title: "title-C",
      body: "body-C",
    });
    FakeNotification.instances[1]?.emit("click");
    expect(onClick).toHaveBeenCalledWith({ target: "C" });
  });

  it("keeps origin-specific distinct keys separate", async () => {
    const { showNativeFeedNotification } = await loadNotifications();

    showNativeFeedNotification(
      [occurrence("host:A", { feedSource: "host" })],
      vi.fn(),
      vi.fn(),
    );
    showNativeFeedNotification(
      [occurrence("cloud:A", { feedSource: "cloud" })],
      vi.fn(),
      vi.fn(),
    );

    expect(FakeNotification.instances).toHaveLength(2);
  });

  it("does not burn receipts when the foreground relay fails, so retry works", async () => {
    const { showNativeFeedNotification } = await loadNotifications();
    FakeBrowserWindow.windows = [{ destroyed: false, focused: true }];

    expect(() =>
      showNativeFeedNotification([occurrence("A", {})], vi.fn(), () => {
        throw new Error("focused renderer unavailable");
      }),
    ).toThrow("focused renderer unavailable");

    const relay = vi.fn();
    const outcome = showNativeFeedNotification(
      [occurrence("A", {})],
      vi.fn(),
      relay,
    );

    // Foreground relay owns presentation: no display for the caller to render.
    expect(outcome).toEqual({
      kind: "feed",
      outcome: "presented",
      display: null,
    });
    expect(relay).toHaveBeenCalledOnce();
  });

  it("returns the filtered display when notifications are unsupported", async () => {
    const { showNativeFeedNotification } = await loadNotifications();
    FakeNotification.supported = false;

    const outcome = showNativeFeedNotification(
      [occurrence("B", {}), occurrence("C", {})],
      vi.fn(),
      vi.fn(),
    );

    expect(outcome).toMatchObject({
      kind: "feed",
      outcome: "undeliverable",
      display: { feedOccurrences: [occurrence("B", {}), occurrence("C", {})] },
    });
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("relays only the filtered feedOccurrences to the foreground renderer", async () => {
    const { showNativeFeedNotification } = await loadNotifications();
    const relay = vi.fn();
    showNativeFeedNotification([occurrence("A", {})], vi.fn(), vi.fn());
    FakeBrowserWindow.windows = [{ destroyed: false, focused: true }];

    showNativeFeedNotification(
      [occurrence("A", {}), occurrence("B", { feedSource: "cloud" })],
      vi.fn(),
      relay,
    );

    expect(relay).toHaveBeenCalledOnce();
    const display = relay.mock.calls[0]?.[0];
    expect(display.feedOccurrences).toEqual([
      occurrence("B", { feedSource: "cloud" }),
    ]);
    expect(display.title).toBe("title-B");
    expect(display.foregroundAppLocal).toBeNull();
  });

  it("does not duplicate after a supported foreground relay", async () => {
    const { showNativeFeedNotification } = await loadNotifications();
    const relay = vi.fn();
    FakeBrowserWindow.windows = [{ destroyed: false, focused: true }];

    showNativeFeedNotification([occurrence("A", {})], vi.fn(), relay);
    FakeBrowserWindow.windows = [{ destroyed: false, focused: false }];
    const outcome = showNativeFeedNotification(
      [occurrence("A", { feedSource: "cloud" })],
      vi.fn(),
      relay,
    );

    expect(outcome).toBe("duplicate");
    expect(relay).toHaveBeenCalledOnce();
    expect(FakeNotification.instances).toHaveLength(0);
  });
});
