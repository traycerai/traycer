/**
 * The iOS status-bar tap adapter: the native bridge controller fires a
 * `statusTap` window event per tap, and the shell forwards it as a
 * payload-free signal on `IRunnerHost.statusBarTap`.
 *
 * The window is replaced by a plain `EventTarget`, so the claims are about the
 * adapter alone: one handler call per tap, silence after disposal, and
 * subscriptions that do not disturb each other.
 */
import { describe, expect, it, vi } from "vitest";
import { MobileStatusBarTap, STATUS_TAP_EVENT } from "../src/status-bar-tap";

describe("MobileStatusBarTap", () => {
  it("calls the subscriber once per status-bar tap", () => {
    const target = new EventTarget();
    const statusBarTap = new MobileStatusBarTap(target);
    const handler = vi.fn();

    statusBarTap.onTap(handler);
    target.dispatchEvent(new Event(STATUS_TAP_EVENT));
    target.dispatchEvent(new Event(STATUS_TAP_EVENT));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("ignores events other than the status-bar tap", () => {
    const target = new EventTarget();
    const statusBarTap = new MobileStatusBarTap(target);
    const handler = vi.fn();

    statusBarTap.onTap(handler);
    target.dispatchEvent(new Event("resize"));

    expect(handler).not.toHaveBeenCalled();
  });

  it("stops delivering once the subscription is disposed", () => {
    const target = new EventTarget();
    const statusBarTap = new MobileStatusBarTap(target);
    const handler = vi.fn();

    const subscription = statusBarTap.onTap(handler);
    subscription.dispose();
    target.dispatchEvent(new Event(STATUS_TAP_EVENT));

    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps subscriptions independent of each other", () => {
    const target = new EventTarget();
    const statusBarTap = new MobileStatusBarTap(target);
    const disposedHandler = vi.fn();
    const liveHandler = vi.fn();

    const disposed = statusBarTap.onTap(disposedHandler);
    statusBarTap.onTap(liveHandler);
    disposed.dispose();
    target.dispatchEvent(new Event(STATUS_TAP_EVENT));

    expect(disposedHandler).not.toHaveBeenCalled();
    expect(liveHandler).toHaveBeenCalledTimes(1);
  });
});
