/**
 * The Android back adapter: the OS back request (hardware key or the system
 * back gesture) arrives through the App plugin's `backButton` event, and the
 * shell forwards it as a payload-free signal on `IRunnerHost.systemBack`.
 *
 * The plugin is faked at the package boundary, as everywhere else in this
 * workspace. The claims: a press reaches the subscriber, a disposed
 * subscription hears nothing more (including when disposal races the plugin's
 * asynchronous attach), and `minimize` reaches the plugin's `minimizeApp`.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginListenerHandle } from "@capacitor/core";
import {
  MobileSystemBack,
  type BackButtonEvent,
  type SystemBackPluginSlice,
} from "../src/system-back";

class FakeAppPlugin implements SystemBackPluginSlice {
  private readonly listeners = new Set<(event: BackButtonEvent) => void>();
  readonly minimizeApp = vi.fn(async (): Promise<void> => {});

  async addListener(
    _eventName: "backButton",
    listener: (event: BackButtonEvent) => void,
  ): Promise<PluginListenerHandle> {
    this.listeners.add(listener);
    return {
      remove: async () => {
        this.listeners.delete(listener);
      },
    };
  }

  press(): void {
    for (const listener of this.listeners) listener({ canGoBack: false });
  }

  get attached(): number {
    return this.listeners.size;
  }
}

/** The plugin attaches asynchronously; let that promise settle. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("MobileSystemBack", () => {
  it("delivers an OS back press to the subscriber", async () => {
    const plugin = new FakeAppPlugin();
    const systemBack = new MobileSystemBack(plugin);
    const handler = vi.fn();

    systemBack.onBack(handler);
    await settle();
    plugin.press();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("stops delivering once the subscription is disposed", async () => {
    const plugin = new FakeAppPlugin();
    const systemBack = new MobileSystemBack(plugin);
    const handler = vi.fn();

    const subscription = systemBack.onBack(handler);
    await settle();
    subscription.dispose();
    await settle();
    plugin.press();

    expect(handler).not.toHaveBeenCalled();
    expect(plugin.attached).toBe(0);
  });

  // React effects can tear down before the plugin's attach promise resolves;
  // a listener attached after its own disposal would fire forever.
  it("detaches a listener disposed before the plugin finished attaching", async () => {
    const plugin = new FakeAppPlugin();
    const systemBack = new MobileSystemBack(plugin);
    const handler = vi.fn();

    const subscription = systemBack.onBack(handler);
    subscription.dispose();
    await settle();
    plugin.press();

    expect(handler).not.toHaveBeenCalled();
    expect(plugin.attached).toBe(0);
  });

  it("sends the app to the background on minimize", async () => {
    const plugin = new FakeAppPlugin();
    const systemBack = new MobileSystemBack(plugin);

    await systemBack.minimize();

    expect(plugin.minimizeApp).toHaveBeenCalledTimes(1);
  });
});
