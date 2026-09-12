import { beforeEach, describe, expect, it, vi } from "vitest";
import { presetDeviceProfile } from "@traycer-clients/shared/platform/browser-device-profiles";
import {
  BrowserPageEmulation,
  type BrowserEmulationDeviceProfile,
} from "../browser-page-emulation";

vi.mock("../../../app/logger", () => ({
  log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  describeLogError: (error: unknown) => ({ message: String(error) }),
}));

interface SentCommand {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface CommandRecorder {
  readonly sent: SentCommand[];
  readonly send: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

function recorder(): CommandRecorder {
  const sent: SentCommand[] = [];
  return {
    sent,
    send: (method, params) => {
      sent.push({ method, params });
      return Promise.resolve(null);
    },
  };
}

function methods(sent: readonly SentCommand[]): readonly string[] {
  return sent.map((entry) => entry.method);
}

function paramsFor(
  sent: readonly SentCommand[],
  method: string,
): Record<string, unknown> {
  const found = sent.find((entry) => entry.method === method);
  if (found === undefined) throw new Error(`${method} was never sent`);
  return found.params;
}

const phoneProfile: BrowserEmulationDeviceProfile =
  presetDeviceProfile("handset-regular");

describe("BrowserPageEmulation appearance", () => {
  it("overrides prefers-color-scheme for an explicit choice", async () => {
    const harness = recorder();
    const emulation = new BrowserPageEmulation(harness.send);
    await emulation.setColorScheme("dark");
    expect(paramsFor(harness.sent, "Emulation.setEmulatedMedia")).toEqual({
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
  });

  it("stops overriding for system, so the page follows the OS again", async () => {
    const harness = recorder();
    const emulation = new BrowserPageEmulation(harness.send);
    await emulation.setColorScheme("dark");
    await emulation.setColorScheme("system");
    const emulated = harness.sent.filter(
      (entry) => entry.method === "Emulation.setEmulatedMedia",
    );
    expect(emulated[emulated.length - 1]?.params).toEqual({ features: [] });
  });
});

describe("BrowserPageEmulation reapply", () => {
  it("restates both overrides, which is what a navigation commit needs", async () => {
    const harness = recorder();
    const emulation = new BrowserPageEmulation(harness.send);
    await emulation.setDeviceProfile(phoneProfile);
    await emulation.setColorScheme("light");
    const before = harness.sent.length;
    await emulation.reapply();
    const after = methods(harness.sent.slice(before));
    expect(after).toContain("Emulation.setDeviceMetricsOverride");
    expect(after).toContain("Emulation.setEmulatedMedia");
  });

  it("keeps the intent when a command fails, so the next commit retries it", async () => {
    let fail = true;
    const sent: SentCommand[] = [];
    const emulation = new BrowserPageEmulation((method, params) => {
      sent.push({ method, params });
      return fail
        ? Promise.reject(new Error("debugger detached"))
        : Promise.resolve(null);
    });
    await emulation.setDeviceProfile(phoneProfile);
    expect(emulation.snapshot().deviceProfile).toEqual(phoneProfile);
    fail = false;
    sent.length = 0;
    await emulation.reapply();
    expect(methods(sent)).toContain("Emulation.setDeviceMetricsOverride");
  });

  it("does not send touch commands for a metrics override that failed", async () => {
    const sent: SentCommand[] = [];
    const emulation = new BrowserPageEmulation((method, params) => {
      sent.push({ method, params });
      return method === "Emulation.setDeviceMetricsOverride"
        ? Promise.reject(new Error("nope"))
        : Promise.resolve(null);
    });
    await emulation.setDeviceProfile(phoneProfile);
    expect(methods(sent)).not.toContain("Emulation.setTouchEmulationEnabled");
  });
});

describe("BrowserPageEmulation cache", () => {
  it("clears through the network domain, never the cookie jar's session", async () => {
    const harness = recorder();
    const emulation = new BrowserPageEmulation(harness.send);
    await expect(emulation.clearCache()).resolves.toBe(true);
    expect(methods(harness.sent)).toEqual(["Network.clearBrowserCache"]);
  });

  it("reports failure instead of throwing at the caller", async () => {
    const emulation = new BrowserPageEmulation(() =>
      Promise.reject(new Error("detached")),
    );
    await expect(emulation.clearCache()).resolves.toBe(false);
  });
});

describe("BrowserPageEmulation device profile", () => {
  it("overrides ratio and mobile without touching the element's geometry", async () => {
    const harness = recorder();
    const emulation = new BrowserPageEmulation(harness.send);
    await emulation.setDeviceProfile({
      devicePixelRatio: 3,
      mobile: true,
      touch: true,
    });
    const params = paramsFor(harness.sent, "Emulation.setDeviceMetricsOverride");
    // Zero edges are CDP's "do not override this dimension": the `<webview>`
    // element stays the only authority on width and height, so the page can
    // never lay out at an override's height inside a shorter box.
    expect(params.width).toBe(0);
    expect(params.height).toBe(0);
    expect(params.deviceScaleFactor).toBe(3);
    expect(params.mobile).toBe(true);
  });

  it("gives a touch class a coarse pointer and mouse-driven touch events", async () => {
    const harness = recorder();
    const emulation = new BrowserPageEmulation(harness.send);
    await emulation.setDeviceProfile({
      devicePixelRatio: 2,
      mobile: true,
      touch: true,
    });
    expect(
      paramsFor(harness.sent, "Emulation.setEmitTouchEventsForMouse"),
    ).toMatchObject({ enabled: true });
  });

  it("returns the page to this machine's own device when cleared", async () => {
    const harness = recorder();
    const emulation = new BrowserPageEmulation(harness.send);
    await emulation.setDeviceProfile({
      devicePixelRatio: 3,
      mobile: true,
      touch: true,
    });
    await emulation.setDeviceProfile(null);
    expect(methods(harness.sent)).toContain(
      "Emulation.clearDeviceMetricsOverride",
    );
  });

  it("restates the profile on a navigation commit", async () => {
    const harness = recorder();
    const emulation = new BrowserPageEmulation(harness.send);
    await emulation.setDeviceProfile({
      devicePixelRatio: 2,
      mobile: true,
      touch: true,
    });
    const before = harness.sent.length;
    await emulation.reapply();
    expect(methods(harness.sent.slice(before))).toContain(
      "Emulation.setDeviceMetricsOverride",
    );
  });
});
