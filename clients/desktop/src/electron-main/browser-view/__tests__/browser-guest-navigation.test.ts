import { beforeEach, describe, expect, it, vi } from "vitest";

const securityMock = vi.hoisted(() => ({
  launchExternalFromGuest: vi.fn((_url: string) => Promise.resolve(true)),
  confirmAndLaunchExternalScheme: vi.fn((_url: string) =>
    Promise.resolve(true),
  ),
  // Mirrors the real sets in `app/security.ts`. Duplicated here because the
  // real module imports `electron`, which cannot load in this node env, so the
  // whole module is stubbed rather than partially mocked via importOriginal.
  SAFE_EXTERNAL_SCHEMES: new Set([
    "mailto:",
    "tel:",
    "sms:",
    "facetime:",
    "facetime-audio:",
  ]),
  DANGEROUS_EXTERNAL_SCHEMES: new Set([
    "javascript:",
    "data:",
    "blob:",
    "file:",
    "filesystem:",
    "chrome:",
    "chrome-extension:",
    "devtools:",
    "vbscript:",
    "ws:",
    "wss:",
  ]),
}));

vi.mock("../../app/security", () => securityMock);

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  guestNavigationGuards,
  handleExternalGuestScheme,
  isAllowedGuestNavigationUrl,
  isAllowedHostInitiatedNavigationUrl,
} from "../browser-guest-navigation";

describe("isAllowedGuestNavigationUrl", () => {
  it.each(["about:blank", "http://example.test/", "https://example.test/"])(
    "allows %s",
    (url) => {
      expect(isAllowedGuestNavigationUrl(url)).toBe(true);
    },
  );

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "traycer://internal/settings",
    "not a url",
  ])("refuses %s - a page must never pivot itself here", (url) => {
    expect(isAllowedGuestNavigationUrl(url)).toBe(false);
  });
});

describe("isAllowedHostInitiatedNavigationUrl", () => {
  it.each([
    "about:blank",
    "http://example.test/",
    "https://example.test/",
    "file:///tmp/modal.html",
  ])("allows %s", (url) => {
    expect(isAllowedHostInitiatedNavigationUrl(url)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "traycer://internal/settings",
    "not a url",
  ])("refuses %s", (url) => {
    expect(isAllowedHostInitiatedNavigationUrl(url)).toBe(false);
  });
});

describe("handleExternalGuestScheme", () => {
  beforeEach(() => {
    securityMock.launchExternalFromGuest.mockClear();
    securityMock.confirmAndLaunchExternalScheme.mockClear();
  });

  it.each(["mailto:a@b.example", "tel:+1", "sms:+1", "facetime:a@b.example"])(
    "hands a gesture-backed safe scheme (%s) straight to the OS, no confirm",
    (url) => {
      expect(handleExternalGuestScheme(url, "will-navigate", true)).toBe(true);
      expect(securityMock.launchExternalFromGuest).toHaveBeenCalledWith(url);
      expect(
        securityMock.confirmAndLaunchExternalScheme,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(["mailto:a@b.example", "tel:+1", "sms:+1"])(
    "confirms a gesture-less safe scheme (%s) instead of silently launching",
    (url) => {
      expect(handleExternalGuestScheme(url, "will-redirect", false)).toBe(true);
      expect(securityMock.confirmAndLaunchExternalScheme).toHaveBeenCalledWith(
        url,
      );
      expect(securityMock.launchExternalFromGuest).not.toHaveBeenCalled();
    },
  );

  it.each(["zoommtg://join", "slack://open", "msteams://chat"])(
    "confirms before opening an arbitrary app deep link (%s), gesture or not",
    (url) => {
      expect(handleExternalGuestScheme(url, "window-open", true)).toBe(true);
      expect(securityMock.confirmAndLaunchExternalScheme).toHaveBeenCalledWith(
        url,
      );
      expect(securityMock.launchExternalFromGuest).not.toHaveBeenCalled();
    },
  );

  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "blob:https://x/1",
    "file:///etc/passwd",
    "filesystem:https://x/temporary/1",
    "about:settings",
    "chrome://settings",
    "chrome-extension://id/x",
    "devtools://devtools/bundled/x",
    "vbscript:msgbox",
    "ws://x/socket",
    "wss://x/socket",
  ])("refuses a dangerous scheme (%s) - never openExternal", (url) => {
    expect(handleExternalGuestScheme(url, "will-navigate", true)).toBe(false);
    expect(securityMock.launchExternalFromGuest).not.toHaveBeenCalled();
    expect(securityMock.confirmAndLaunchExternalScheme).not.toHaveBeenCalled();
  });

  it.each(["http://x.example/", "https://x.example/", "about:blank"])(
    "leaves web schemes (%s) to the caller's own policy",
    (url) => {
      expect(handleExternalGuestScheme(url, "will-navigate", true)).toBe(false);
      expect(securityMock.launchExternalFromGuest).not.toHaveBeenCalled();
      expect(
        securityMock.confirmAndLaunchExternalScheme,
      ).not.toHaveBeenCalled();
    },
  );
});

describe("guestNavigationGuards external routing", () => {
  beforeEach(() => {
    securityMock.launchExternalFromGuest.mockClear();
    securityMock.confirmAndLaunchExternalScheme.mockClear();
  });

  it("routes a gesture-backed will-navigate straight to the OS", () => {
    const guards = guestNavigationGuards(() => true);
    let prevented = 0;
    guards["will-navigate"](
      { url: "mailto:a@b.example", preventDefault: () => (prevented += 1) },
      "mailto:a@b.example",
    );
    expect(prevented).toBe(1);
    expect(securityMock.launchExternalFromGuest).toHaveBeenCalledWith(
      "mailto:a@b.example",
    );
  });

  it("confirms a gesture-less will-redirect to a safe scheme", () => {
    const guards = guestNavigationGuards(() => false);
    let prevented = 0;
    guards["will-redirect"](
      { url: "mailto:a@b.example", preventDefault: () => (prevented += 1) },
      "mailto:a@b.example",
    );
    expect(prevented).toBe(1);
    expect(securityMock.confirmAndLaunchExternalScheme).toHaveBeenCalledWith(
      "mailto:a@b.example",
    );
    expect(securityMock.launchExternalFromGuest).not.toHaveBeenCalled();
  });

  it("does NOT route a hidden subframe (will-frame-navigate) externally", () => {
    const guards = guestNavigationGuards(() => true);
    let prevented = 0;
    guards["will-frame-navigate"]({
      url: "mailto:a@b.example",
      preventDefault: () => (prevented += 1),
    });
    expect(prevented).toBe(1);
    expect(securityMock.launchExternalFromGuest).not.toHaveBeenCalled();
    expect(securityMock.confirmAndLaunchExternalScheme).not.toHaveBeenCalled();
  });
});
