/**
 * Hand-written fakes for the two native-boundary slices `MobileAuthSheet`
 * depends on - the OS auth-sheet plugin and the `@capacitor/app` `appUrlOpen`
 * bridge - mirroring the plugin-mocking convention the rest of this
 * workspace's `__tests__/` use: fake at the package boundary, plain classes
 * with `vi.fn` spies, never touching real Capacitor.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginListenerHandle } from "@capacitor/core";
import {
  MobileAuthSheet,
  type AppUrlOpenSlice,
  type AuthSessionOpenResult,
  type AuthSessionPluginSlice,
} from "../src/auth-sheet";

const SCHEME = "traycer";

class FakeAuthSessionPlugin implements AuthSessionPluginSlice {
  readonly open = vi.fn(
    async (options: {
      readonly url: string;
      readonly callbackScheme: string;
    }): Promise<AuthSessionOpenResult> => {
      void options;
      return { outcome: "opened" };
    },
  );
  readonly close = vi.fn(async (): Promise<void> => {});
}

class FakeAppUrlOpenSlice implements AppUrlOpenSlice {
  private readonly listeners: Array<(event: { readonly url: string }) => void> =
    [];
  rejectAddListener = false;

  addListener(
    eventName: "appUrlOpen",
    listener: (event: { readonly url: string }) => void,
  ): Promise<PluginListenerHandle> {
    void eventName;
    if (this.rejectAddListener) {
      return Promise.reject(new Error("no plugin bridge"));
    }
    this.listeners.push(listener);
    return Promise.resolve({ remove: () => Promise.resolve() });
  }

  get listenerCount(): number {
    return this.listeners.length;
  }

  /** Fires `appUrlOpen`, as the OS does for an app already running. */
  fire(url: string): void {
    for (const listener of [...this.listeners]) {
      listener({ url });
    }
  }
}

/** Lets a fire-and-forget promise chain (the `addListener` attach) settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("MobileAuthSheet", () => {
  describe("open", () => {
    it("passes {url, callbackScheme} to the plugin and resolves true", async () => {
      const plugin = new FakeAuthSessionPlugin();
      const app = new FakeAppUrlOpenSlice();
      const sheet = new MobileAuthSheet(plugin, app, SCHEME);

      await expect(
        sheet.open("https://app.traycer.test/device?user_code=ABC"),
      ).resolves.toBe(true);

      expect(plugin.open).toHaveBeenCalledTimes(1);
      expect(plugin.open).toHaveBeenCalledWith({
        url: "https://app.traycer.test/device?user_code=ABC",
        callbackScheme: SCHEME,
      });
    });

    it("fires every onReturn handler exactly once when the plugin resolves callback", async () => {
      const plugin = new FakeAuthSessionPlugin();
      plugin.open.mockResolvedValue({ outcome: "callback" });
      const app = new FakeAppUrlOpenSlice();
      const sheet = new MobileAuthSheet(plugin, app, SCHEME);
      const first = vi.fn();
      const second = vi.fn();
      sheet.onReturn(first);
      sheet.onReturn(second);
      await flush();

      await expect(sheet.open("https://app.traycer.test/device")).resolves.toBe(
        true,
      );

      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    });

    it("still calls the second onReturn handler and resolves true when the first throws", async () => {
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        const plugin = new FakeAuthSessionPlugin();
        plugin.open.mockResolvedValue({ outcome: "callback" });
        const app = new FakeAppUrlOpenSlice();
        const sheet = new MobileAuthSheet(plugin, app, SCHEME);
        const first = vi.fn(() => {
          throw new Error("first handler boom");
        });
        const second = vi.fn();
        sheet.onReturn(first);
        sheet.onReturn(second);
        await flush();

        await expect(
          sheet.open("https://app.traycer.test/device"),
        ).resolves.toBe(true);

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("fires no handler when the plugin resolves dismissed", async () => {
      const plugin = new FakeAuthSessionPlugin();
      plugin.open.mockResolvedValue({ outcome: "dismissed" });
      const app = new FakeAppUrlOpenSlice();
      const sheet = new MobileAuthSheet(plugin, app, SCHEME);
      const handler = vi.fn();
      sheet.onReturn(handler);
      await flush();

      await expect(sheet.open("https://app.traycer.test/device")).resolves.toBe(
        true,
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it("fires no handler when the plugin resolves opened", async () => {
      const plugin = new FakeAuthSessionPlugin();
      plugin.open.mockResolvedValue({ outcome: "opened" });
      const app = new FakeAppUrlOpenSlice();
      const sheet = new MobileAuthSheet(plugin, app, SCHEME);
      const handler = vi.fn();
      sheet.onReturn(handler);
      await flush();

      await expect(sheet.open("https://app.traycer.test/device")).resolves.toBe(
        true,
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it("resolves false when the plugin rejects - the fallback contract - and fires no handler", async () => {
      const plugin = new FakeAuthSessionPlugin();
      plugin.open.mockRejectedValue(new Error("OS refused to present"));
      const app = new FakeAppUrlOpenSlice();
      const sheet = new MobileAuthSheet(plugin, app, SCHEME);
      const handler = vi.fn();
      sheet.onReturn(handler);
      await flush();

      await expect(sheet.open("https://app.traycer.test/device")).resolves.toBe(
        false,
      );

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("close", () => {
    it("does not call the plugin before any open()", () => {
      const plugin = new FakeAuthSessionPlugin();
      const app = new FakeAppUrlOpenSlice();
      const sheet = new MobileAuthSheet(plugin, app, SCHEME);

      sheet.close();

      expect(plugin.close).not.toHaveBeenCalled();
    });

    it("calls the plugin once after open() resolves opened (Android), and a second close() is a no-op", async () => {
      const plugin = new FakeAuthSessionPlugin();
      plugin.open.mockResolvedValue({ outcome: "opened" });
      const app = new FakeAppUrlOpenSlice();
      const sheet = new MobileAuthSheet(plugin, app, SCHEME);

      await expect(sheet.open("https://app.traycer.test/device")).resolves.toBe(
        true,
      );

      sheet.close();
      expect(plugin.close).toHaveBeenCalledTimes(1);

      sheet.close();
      expect(plugin.close).toHaveBeenCalledTimes(1);
    });

    it("does not call the plugin once the return-link appUrlOpen fired after an opened tab", async () => {
      const plugin = new FakeAuthSessionPlugin();
      plugin.open.mockResolvedValue({ outcome: "opened" });
      const app = new FakeAppUrlOpenSlice();
      const sheet = new MobileAuthSheet(plugin, app, SCHEME);
      sheet.onReturn(vi.fn());
      await flush();

      await expect(sheet.open("https://app.traycer.test/device")).resolves.toBe(
        true,
      );
      app.fire(`${SCHEME}://auth/callback`);

      sheet.close();
      expect(plugin.close).not.toHaveBeenCalled();
    });

    it("does not call the plugin after open() resolved dismissed (iOS)", async () => {
      const plugin = new FakeAuthSessionPlugin();
      plugin.open.mockResolvedValue({ outcome: "dismissed" });
      const app = new FakeAppUrlOpenSlice();
      const sheet = new MobileAuthSheet(plugin, app, SCHEME);

      await expect(sheet.open("https://app.traycer.test/device")).resolves.toBe(
        true,
      );

      sheet.close();
      expect(plugin.close).not.toHaveBeenCalled();
    });

    it("does not call the plugin after open() resolved callback (iOS)", async () => {
      const plugin = new FakeAuthSessionPlugin();
      plugin.open.mockResolvedValue({ outcome: "callback" });
      const app = new FakeAppUrlOpenSlice();
      const sheet = new MobileAuthSheet(plugin, app, SCHEME);

      await expect(sheet.open("https://app.traycer.test/device")).resolves.toBe(
        true,
      );

      sheet.close();
      expect(plugin.close).not.toHaveBeenCalled();
    });

    it("swallows a rejection with no unhandled rejection", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        const plugin = new FakeAuthSessionPlugin();
        plugin.open.mockResolvedValue({ outcome: "opened" });
        plugin.close.mockRejectedValue(new Error("nothing to dismiss"));
        const app = new FakeAppUrlOpenSlice();
        const sheet = new MobileAuthSheet(plugin, app, SCHEME);
        await expect(
          sheet.open("https://app.traycer.test/device"),
        ).resolves.toBe(true);

        sheet.close();
        await flush();

        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });

  describe("onReturn", () => {
    it("registers the appUrlOpen listener lazily and only once across multiple subscriptions", async () => {
      const plugin = new FakeAuthSessionPlugin();
      const app = new FakeAppUrlOpenSlice();
      const sheet = new MobileAuthSheet(plugin, app, SCHEME);

      expect(app.listenerCount).toBe(0);

      sheet.onReturn(vi.fn());
      await flush();
      expect(app.listenerCount).toBe(1);

      sheet.onReturn(vi.fn());
      await flush();
      expect(app.listenerCount).toBe(1);
    });

    it("fires handlers when appUrlOpen carries a URL starting with <scheme>://auth/callback", async () => {
      const plugin = new FakeAuthSessionPlugin();
      const app = new FakeAppUrlOpenSlice();
      const sheet = new MobileAuthSheet(plugin, app, SCHEME);
      const handler = vi.fn();
      sheet.onReturn(handler);
      await flush();

      app.fire(`${SCHEME}://auth/callback?state=abc`);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("does not fire for a link-login code URL or a different scheme", async () => {
      const plugin = new FakeAuthSessionPlugin();
      const app = new FakeAppUrlOpenSlice();
      const sheet = new MobileAuthSheet(plugin, app, SCHEME);
      const handler = vi.fn();
      sheet.onReturn(handler);
      await flush();

      app.fire("https://platform.traycer.ai/link?code=ABCDE-FGHJK");
      app.fire("traycer-staging://auth/callback");

      expect(handler).not.toHaveBeenCalled();
    });

    it("stops firing a disposed handler", async () => {
      const plugin = new FakeAuthSessionPlugin();
      const app = new FakeAppUrlOpenSlice();
      const sheet = new MobileAuthSheet(plugin, app, SCHEME);
      const handler = vi.fn();
      const subscription = sheet.onReturn(handler);
      await flush();

      subscription.dispose();
      app.fire(`${SCHEME}://auth/callback`);

      expect(handler).not.toHaveBeenCalled();
    });

    it("swallows a rejecting addListener via console.warn without breaking open()", async () => {
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      try {
        const plugin = new FakeAuthSessionPlugin();
        plugin.open.mockResolvedValue({ outcome: "callback" });
        const app = new FakeAppUrlOpenSlice();
        app.rejectAddListener = true;
        const sheet = new MobileAuthSheet(plugin, app, SCHEME);
        const handler = vi.fn();
        sheet.onReturn(handler);
        await flush();

        expect(warn).toHaveBeenCalledTimes(1);

        // open() still works: the sheet's own completion outcome fires the
        // handler even though the appUrlOpen listener failed to register.
        await expect(
          sheet.open("https://app.traycer.test/device"),
        ).resolves.toBe(true);
        expect(handler).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
