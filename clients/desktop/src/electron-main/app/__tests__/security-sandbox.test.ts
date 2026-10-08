import { session } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appliesAppContentSecurityPolicy,
  installContentSecurityPolicy,
  installPermissionHandlers,
  isAllowedAppSubframeNavigation,
  isSandboxSubframePermissionGranted,
} from "../security";
import { CONTENT_SECURITY_POLICY } from "../../../shared/content-security-policy";

interface FakeDetails {
  readonly url: string;
  readonly resourceType: string;
  readonly responseHeaders: Record<string, string[]>;
}
type HeadersListener = (
  details: FakeDetails,
  callback: (response: {
    readonly responseHeaders: Record<string, string[]>;
  }) => void,
) => void;
type RequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: unknown,
) => void;
type CheckHandler = (
  webContents: unknown,
  permission: string,
  origin: string,
  details: unknown,
) => boolean;

const state = vi.hoisted(() => ({
  fake: null as {
    headersListener: unknown;
    requestHandler: unknown;
    checkHandler: unknown;
  } | null,
}));

vi.mock("electron", () => ({
  shell: { openExternal: (): Promise<void> => Promise.resolve() },
  dialog: {},
  session: {
    get defaultSession(): unknown {
      state.fake = state.fake ?? {
        headersListener: null,
        requestHandler: null,
        checkHandler: null,
      };
      const fake = state.fake;
      return {
        webRequest: {
          onHeadersReceived: (listener: unknown): void => {
            fake.headersListener = listener;
          },
        },
        setPermissionRequestHandler: (handler: unknown): void => {
          fake.requestHandler = handler;
        },
        setPermissionCheckHandler: (handler: unknown): void => {
          fake.checkHandler = handler;
        },
        setDevicePermissionHandler: (): void => undefined,
        setUSBProtectedClassesHandler: (): void => undefined,
        setBluetoothPairingHandler: (): void => undefined,
        setDisplayMediaRequestHandler: (): void => undefined,
      };
    },
  },
}));

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const LOADER = "traycer-sandbox://page/index.html";
const APP_URL = "app://renderer/index.html";

function isRequestHandler(value: unknown): value is RequestHandler {
  return typeof value === "function";
}
function isCheckHandler(value: unknown): value is CheckHandler {
  return typeof value === "function";
}
function isHeadersListener(value: unknown): value is HeadersListener {
  return typeof value === "function";
}

function requestPermission(
  permission: string,
  details: Record<string, unknown>,
): boolean {
  const handler = state.fake?.requestHandler;
  if (!isRequestHandler(handler)) throw new Error("handler not installed");
  const results: boolean[] = [];
  handler(null, permission, (granted) => results.push(granted), details);
  const result = results.at(0);
  if (result === undefined) throw new Error("callback never called");
  return result;
}

function checkPermission(
  permission: string,
  details: Record<string, unknown>,
): boolean {
  const handler = state.fake?.checkHandler;
  if (!isCheckHandler(handler)) throw new Error("handler not installed");
  return handler(null, permission, "", details);
}

beforeEach(() => {
  state.fake = null;
});

describe("content security policy hook", () => {
  it.each([
    [LOADER, "mainFrame"],
    ["traycer-sandbox://page/loader.js", "script"],
    [APP_URL, "subFrame"],
    ["https://example.com/embed", "subFrame"],
  ])("leaves %s (%s) to its own policy", (url, resourceType) => {
    expect(appliesAppContentSecurityPolicy(url, resourceType)).toBe(false);
  });

  it.each([
    [APP_URL, "mainFrame"],
    ["app://renderer/assets/index.js", "script"],
    ["https://api.example.com/v1", "xhr"],
  ])("still applies to %s (%s)", (url, resourceType) => {
    expect(appliesAppContentSecurityPolicy(url, resourceType)).toBe(true);
  });

  it("writes the app policy on a main-renderer response and not on a sandbox one", () => {
    installContentSecurityPolicy(session.defaultSession);
    const listener = state.fake?.headersListener;
    if (!isHeadersListener(listener)) throw new Error("hook not installed");
    const run = (url: string, resourceType: string) => {
      const answers: Record<string, string[]>[] = [];
      listener({ url, resourceType, responseHeaders: {} }, (response) =>
        answers.push(response.responseHeaders),
      );
      return answers.at(0);
    };
    expect(run(APP_URL, "mainFrame")).toEqual({
      "Content-Security-Policy": [CONTENT_SECURITY_POLICY],
    });
    expect(run(LOADER, "subFrame")).toEqual({});
  });
});

describe("isSandboxSubframePermissionGranted", () => {
  it("grants only what ?perm= declared", () => {
    const url = `${LOADER}?perm=camera,clipboard-write`;
    expect(isSandboxSubframePermissionGranted("media", url, ["video"])).toBe(
      true,
    );
    expect(
      isSandboxSubframePermissionGranted("clipboard-sanitized-write", url, []),
    ).toBe(true);
    expect(isSandboxSubframePermissionGranted("media", url, ["audio"])).toBe(
      false,
    );
    expect(
      isSandboxSubframePermissionGranted("media", url, ["video", "audio"]),
    ).toBe(false);
    expect(isSandboxSubframePermissionGranted("media", url, [])).toBe(false);
    expect(isSandboxSubframePermissionGranted("geolocation", url, [])).toBe(
      false,
    );
  });

  it("grants nothing to a loader that declared nothing or to a non-sandbox frame", () => {
    expect(isSandboxSubframePermissionGranted("geolocation", LOADER, [])).toBe(
      false,
    );
    expect(
      isSandboxSubframePermissionGranted(
        "geolocation",
        "https://example.com/?perm=geolocation",
        [],
      ),
    ).toBe(false);
    expect(
      isSandboxSubframePermissionGranted(
        "geolocation",
        "traycer-sandbox://page/loader.js?perm=geolocation",
        [],
      ),
    ).toBe(false);
  });
});

describe("permission handlers", () => {
  beforeEach(() => {
    installPermissionHandlers(session.defaultSession);
  });

  it("grants a sandbox frame only its declared permission", () => {
    const details = {
      isMainFrame: false,
      requestingUrl: `${LOADER}?perm=geolocation`,
    };
    expect(requestPermission("geolocation", details)).toBe(true);
    expect(requestPermission("clipboard-read", details)).toBe(false);
    expect(requestPermission("fullscreen", details)).toBe(false);
    expect(
      checkPermission("geolocation", {
        isMainFrame: false,
        requestingUrl: `${LOADER}?perm=geolocation`,
      }),
    ).toBe(true);
    expect(
      checkPermission("clipboard-sanitized-write", {
        isMainFrame: false,
        requestingUrl: `${LOADER}?perm=geolocation`,
      }),
    ).toBe(false);
  });

  it("does not hand a non-sandbox subframe the main-frame grants", () => {
    const details = {
      isMainFrame: false,
      requestingUrl: "https://example.com/embed",
      mediaTypes: ["audio"],
    };
    expect(requestPermission("clipboard-read", details)).toBe(false);
    expect(requestPermission("media", details)).toBe(false);
    expect(
      checkPermission("media", {
        isMainFrame: false,
        requestingUrl: "https://example.com/embed",
        mediaType: "audio",
      }),
    ).toBe(false);
  });

  it("keeps the main-frame grants: dictation mic, clipboard, fullscreen", () => {
    const main = { isMainFrame: true, requestingUrl: APP_URL };
    expect(requestPermission("media", { ...main, mediaTypes: ["audio"] })).toBe(
      true,
    );
    expect(
      requestPermission("media", { ...main, mediaTypes: ["audio", "video"] }),
    ).toBe(false);
    expect(requestPermission("clipboard-read", main)).toBe(true);
    expect(requestPermission("clipboard-sanitized-write", main)).toBe(true);
    expect(requestPermission("fullscreen", main)).toBe(true);
    expect(requestPermission("geolocation", main)).toBe(false);
    expect(checkPermission("media", { ...main, mediaType: "audio" })).toBe(
      true,
    );
    expect(checkPermission("media", { ...main, mediaType: "video" })).toBe(
      false,
    );
    expect(checkPermission("media", main)).toBe(false);
    expect(checkPermission("fullscreen", main)).toBe(true);
    expect(checkPermission("geolocation", main)).toBe(false);
  });
});

describe("isAllowedAppSubframeNavigation", () => {
  it("lets a sandbox root load only the loader", () => {
    expect(isAllowedAppSubframeNavigation(LOADER, true)).toBe(true);
    expect(isAllowedAppSubframeNavigation(`${LOADER}?perm=camera`, true)).toBe(
      true,
    );
    expect(
      isAllowedAppSubframeNavigation("traycer-sandbox://page/loader.js", true),
    ).toBe(false);
    expect(isAllowedAppSubframeNavigation("https://example.com/", true)).toBe(
      false,
    );
    expect(isAllowedAppSubframeNavigation("about:blank", true)).toBe(false);
  });

  it("lets a deeper frame load http(s) and about: documents only", () => {
    expect(isAllowedAppSubframeNavigation("https://example.com/", false)).toBe(
      true,
    );
    expect(isAllowedAppSubframeNavigation("http://example.com/", false)).toBe(
      true,
    );
    expect(isAllowedAppSubframeNavigation("about:blank", false)).toBe(true);
    expect(isAllowedAppSubframeNavigation("about:srcdoc", false)).toBe(true);
    expect(isAllowedAppSubframeNavigation("file:///etc/passwd", false)).toBe(
      false,
    );
    expect(isAllowedAppSubframeNavigation(APP_URL, false)).toBe(false);
    expect(isAllowedAppSubframeNavigation(LOADER, false)).toBe(false);
    expect(isAllowedAppSubframeNavigation("javascript:alert(1)", false)).toBe(
      false,
    );
    expect(isAllowedAppSubframeNavigation("not a url", false)).toBe(false);
  });
});
