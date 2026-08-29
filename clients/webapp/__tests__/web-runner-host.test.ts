import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WebCredentialStorage,
  WebLockManager,
} from "@traycer-clients/webapp/web-token-store";
import { WebRunnerHost } from "@traycer-clients/webapp/web-runner-host";

function inMemoryStorage(): WebCredentialStorage {
  const values = new Map<string, string>();
  return {
    read: (key) => values.get(key) ?? null,
    write: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
    onExternalChange: (key, handler) => {
      void key;
      void handler;
    },
  };
}

const passthroughLocks: WebLockManager = {
  runExclusive: (name, task) => {
    void name;
    return task();
  },
};

function runner(): WebRunnerHost {
  return new WebRunnerHost({
    signInUrl: "https://platform.test/sign-in",
    authnBaseUrl: "https://authn.test",
    hostLabel: "Traycer Web",
    relayBaseUrl: "wss://relay.test/attach",
    credentialStorage: inMemoryStorage(),
    locks: passthroughLocks,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WebRunnerHost capability posture", () => {
  it("declares no local host and no native folder picker", async () => {
    const host = runner();

    expect(host.hasLocalHost).toBe(false);
    // The browser is already the tab bar: a strip inside one of its tabs
    // would be a second row of tabs above the one in use.
    expect(host.hasAppTabs).toBe(false);
    expect(host.workspaceFolders.canPickNatively).toBe(false);
    expect(await host.workspaceFolders.pickFolders()).toEqual([]);
    expect(await host.getLastKnownLocalHostId()).toBeNull();
  });

  it("emits a single null local-host snapshot and never transitions", () => {
    const host = runner();
    const snapshots: (unknown | null)[] = [];

    // The contract requires the handler to fire SYNCHRONOUSLY on subscribe,
    // so consumers that observe the stream never branch on capability.
    const subscription = host.onLocalHostChange((snapshot) => {
      snapshots.push(snapshot);
    });
    subscription.dispose();

    expect(snapshots).toEqual([null]);
  });

  it("declines a host respawn rather than rejecting", async () => {
    const result = await runner().requestHostRespawn();

    expect(result.kind).toBe("declined");
  });

  it("nulls every capability the browser has no access to", () => {
    const host = runner();

    expect(host.zoom).toBeNull();
    expect(host.service).toBeNull();
    expect(host.traycerCli).toBeNull();
    expect(host.migration).toBeNull();
    expect(host.hostManagement).toBeNull();
    expect(host.hostTray).toBeNull();
    expect(host.pushPermission).toBeNull();
    expect(host.linkCodeScanner).toBeNull();
    expect(host.deviceDescriber).toBeNull();
    expect(host.linkLoginDeepLinks).toBeNull();
    // `null`, not a no-op subscription: this shell owns no registry cadence,
    // and the directory has to know to keep its own timer.
    expect(host.onRegisteredHostsChange(() => undefined)).toBeNull();
  });

  it("reports notifications as presented so callers add no second cue", async () => {
    const outcome = await runner().notifications.show(
      "title",
      "body",
      null,
      null,
      null,
      null,
      null,
    );

    expect(outcome).toBe("presented");
  });

  it("offers no native editor launch", async () => {
    expect(await runner().getRegisteredUrlSchemes(["vscode"])).toEqual([]);
  });
});

describe("WebRunnerHost external links", () => {
  it("opens a new browsing context instead of navigating this one", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const href = window.location.href;

    await runner().openExternalLink("https://example.test/docs");

    // The whole point: every markdown, settings and sign-in link routes
    // through here, and a same-tab navigation would tear down the in-flight
    // device-flow poll along with the app - so the named target is asserted,
    // and this document is asserted not to have moved.
    expect(open).toHaveBeenCalledWith(
      "https://example.test/docs",
      "_blank",
      "noopener,noreferrer",
    );
    expect(window.location.href).toBe(href);
  });
});
