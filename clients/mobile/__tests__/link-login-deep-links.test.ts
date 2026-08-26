/**
 * The capture→route seam for a QR scanned by the SYSTEM camera. jsdom cannot
 * produce a real deep link, so what is exercised here is the boundary the OS
 * hands to: a faked `@capacitor/app` slice on one side, the subscription the
 * GUI bridge makes on the other, and the two delivery orders in between.
 *
 * The orders are the point. A WARM open has a subscriber already; a COLD start
 * does not exist yet when the URL arrives, and if the code is not retained
 * across that gap the launch that caused the sign-in is the one that loses it.
 */
import { describe, expect, it, vi } from "vitest";
import type { LinkLoginDeepLinkDelivery } from "@traycer-clients/shared/platform/runner-host";
import {
  MobileLinkLoginDeepLinks,
  type AppPluginSlice,
} from "../src/link-login-deep-links";

const CODE = "ABCDE-FGHJK";
const NORMALIZED = "ABCDEFGHJK";
const PAYLOAD = `https://platform.traycer.ai/link?code=${CODE}`;

interface FakeApp {
  readonly plugin: AppPluginSlice;
  /** Fires `appUrlOpen`, as the OS does for an app that is already running. */
  open(url: string): void;
}

/**
 * `launchUrl` is what the plugin reports for the URL that STARTED the app -
 * `undefined` when the app was opened normally, which is the plugin's own
 * spelling for "nothing launched it".
 */
function fakeApp(launchUrl: string | undefined): FakeApp {
  const listeners: ((event: { readonly url: string }) => void)[] = [];
  return {
    plugin: {
      getLaunchUrl: () =>
        Promise.resolve(
          launchUrl === undefined ? undefined : { url: launchUrl },
        ),
      addListener: (eventName, listener) => {
        void eventName;
        listeners.push(listener);
        return Promise.resolve({ remove: () => Promise.resolve() });
      },
    },
    open: (url: string) => {
      for (const listener of listeners) {
        listener({ url });
      }
    },
  };
}

/** Lets the plugin's promises settle, since `start()` never awaits them. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("MobileLinkLoginDeepLinks", () => {
  it("replays a cold-start launch URL to a subscriber that arrives later", async () => {
    const app = fakeApp(PAYLOAD);
    const deepLinks = new MobileLinkLoginDeepLinks(app.plugin);
    deepLinks.start();
    await flush();

    // The GUI mounts only now - after the host runtime has booted.
    const received: string[] = [];
    deepLinks.onLinkLoginCode((delivery) => received.push(delivery.code));

    expect(received).toEqual([NORMALIZED]);
  });

  it("delivers a warm open straight to the subscriber", async () => {
    const app = fakeApp(undefined);
    const deepLinks = new MobileLinkLoginDeepLinks(app.plugin);
    deepLinks.start();
    await flush();
    const received: string[] = [];
    deepLinks.onLinkLoginCode((delivery) => received.push(delivery.code));

    app.open(PAYLOAD);

    expect(received).toEqual([NORMALIZED]);
  });

  it("still accepts the superseded traycer:// payload", async () => {
    const app = fakeApp(`traycer://link-login?code=${CODE}`);
    const deepLinks = new MobileLinkLoginDeepLinks(app.plugin);
    deepLinks.start();
    await flush();
    const received: string[] = [];
    deepLinks.onLinkLoginCode((delivery) => received.push(delivery.code));

    expect(received).toEqual([NORMALIZED]);
  });

  it("emits once when the launch URL is also announced as an open", async () => {
    // iOS can do both for a single cold launch. Two claims is not a harmless
    // repeat: the second one is rejected, and the user sees "invalid code" on
    // a sign-in that was working.
    const app = fakeApp(PAYLOAD);
    const deepLinks = new MobileLinkLoginDeepLinks(app.plugin);
    deepLinks.start();
    await flush();
    const received: string[] = [];
    deepLinks.onLinkLoginCode((delivery) => received.push(delivery.code));

    app.open(PAYLOAD);

    expect(received).toEqual([NORMALIZED]);
  });

  it("drops every URL that is not a link-login payload, silently", async () => {
    const app = fakeApp(undefined);
    const deepLinks = new MobileLinkLoginDeepLinks(app.plugin);
    deepLinks.start();
    await flush();
    const received: string[] = [];
    deepLinks.onLinkLoginCode((delivery) => received.push(delivery.code));

    // The device-approval page's return link, which fires on every browser
    // sign-in and carries no payload at all.
    app.open("traycer://auth/callback");
    app.open("https://platform.traycer.ai/link");
    app.open("https://platform.traycer.ai/settings?code=ABCDE-FGHJK");
    app.open("not a url");

    expect(received).toEqual([]);
  });

  it("keeps only the newest code while nothing is subscribed", async () => {
    const app = fakeApp(undefined);
    const deepLinks = new MobileLinkLoginDeepLinks(app.plugin);
    deepLinks.start();
    await flush();

    app.open(PAYLOAD);
    app.open("https://platform.traycer.ai/link?code=22222-33333");

    const received: string[] = [];
    deepLinks.onLinkLoginCode((delivery) => received.push(delivery.code));

    // The account holds one live unclaimed code, so the first was already dead
    // by the time the second was minted.
    expect(received).toEqual(["2222233333"]);
  });

  it("delivers a deliberate rescan once the delivery burst has passed", async () => {
    // The dedupe exists for one arrival announced twice, milliseconds apart.
    // It must not outlive that: scanning while signed in is discarded upstream
    // with a notice, and the user's answer to that notice is to sign out and
    // scan the same still-live QR again. A lifetime memory swallows exactly
    // that second, deliberate scan.
    vi.useFakeTimers();
    try {
      const app = fakeApp(undefined);
      const deepLinks = new MobileLinkLoginDeepLinks(app.plugin);
      deepLinks.start();
      await flush();
      const received: string[] = [];
      deepLinks.onLinkLoginCode((delivery) => received.push(delivery.code));

      app.open(PAYLOAD);
      // Long enough to be a person deciding, not the OS repeating itself.
      vi.advanceTimersByTime(6_000);
      app.open(PAYLOAD);

      expect(received).toEqual([NORMALIZED, NORMALIZED]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives every accepted arrival its own identity, repeats included", async () => {
    // The consumer must be able to ask "have I acted on THIS arrival" without
    // using the code as its own identity - two arrivals of one code are a
    // rescan the second time, and a value-keyed guard cannot tell them apart.
    vi.useFakeTimers();
    try {
      const app = fakeApp(undefined);
      const deepLinks = new MobileLinkLoginDeepLinks(app.plugin);
      deepLinks.start();
      await flush();
      const received: LinkLoginDeepLinkDelivery[] = [];
      deepLinks.onLinkLoginCode((delivery) => received.push(delivery));

      app.open(PAYLOAD);
      vi.advanceTimersByTime(6_000);
      app.open(PAYLOAD);

      expect(received.map((delivery) => delivery.code)).toEqual([
        NORMALIZED,
        NORMALIZED,
      ]);
      expect(received[0]?.deliveryId).not.toBe(received[1]?.deliveryId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops delivering to a disposed subscriber", async () => {
    const app = fakeApp(undefined);
    const deepLinks = new MobileLinkLoginDeepLinks(app.plugin);
    deepLinks.start();
    await flush();
    const handler = vi.fn();
    const subscription = deepLinks.onLinkLoginCode(handler);

    subscription.dispose();
    app.open(PAYLOAD);

    expect(handler).not.toHaveBeenCalled();
  });

  it("survives a plugin that rejects, rather than failing the boot", async () => {
    const failing: AppPluginSlice = {
      getLaunchUrl: () => Promise.reject(new Error("no plugin")),
      addListener: () => Promise.reject(new Error("no plugin")),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deepLinks = new MobileLinkLoginDeepLinks(failing);

    expect(() => deepLinks.start()).not.toThrow();
    await flush();
    await flush();

    warn.mockRestore();
  });
});
