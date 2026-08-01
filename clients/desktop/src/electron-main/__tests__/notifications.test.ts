import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type NotificationEventName = "close" | "click";

class FakeNotification {
  static supported = true;
  static instances: FakeNotification[] = [];

  readonly close = vi.fn();
  readonly show = vi.fn();
  private readonly listeners = new Map<
    NotificationEventName,
    Array<() => void>
  >();

  constructor(_options: { readonly title: string; readonly body: string }) {
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

    showNativeNotification(options);
    showNativeNotification(options);

    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]?.show).toHaveBeenCalledOnce();
  });
});
