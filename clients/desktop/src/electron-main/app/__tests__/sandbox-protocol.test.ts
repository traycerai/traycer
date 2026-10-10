import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installSandboxProtocolHandler,
  isSandboxLoaderUrl,
  SANDBOX_CONTENT_SECURITY_POLICY,
  sandboxDeclaredGrants,
} from "../sandbox-protocol";

type SandboxHandler = (request: { readonly url: string }) => Promise<Response>;

const state = vi.hoisted(() => ({
  handler: null as SandboxHandler | null,
  fetchCalls: 0,
  upstreamOk: true,
}));

vi.mock("electron", () => ({
  protocol: {
    handle: (_scheme: string, handler: SandboxHandler): void => {
      state.handler = handler;
    },
  },
  net: {
    fetch: (): Promise<Response> => {
      state.fetchCalls += 1;
      return Promise.resolve(
        new Response("body", { status: state.upstreamOk ? 200 : 500 }),
      );
    },
  },
}));

vi.mock("../../../config", () => ({ isDevBuild: true }));

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function serve(url: string): Promise<Response> {
  if (state.handler === null) throw new Error("handler not installed");
  return state.handler({ url });
}

beforeEach(() => {
  state.handler = null;
  state.fetchCalls = 0;
  state.upstreamOk = true;
  installSandboxProtocolHandler();
});

describe("sandbox protocol handler", () => {
  it.each([
    ["/index.html", "text/html; charset=utf-8"],
    ["/loader.js", "text/javascript; charset=utf-8"],
  ])("serves %s with the base policy header", async (path, contentType) => {
    const response = await serve(`traycer-sandbox://page${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(contentType);
    expect(response.headers.get("Content-Security-Policy")).toBe(
      SANDBOX_CONTENT_SECURITY_POLICY,
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it.each([
    "traycer-sandbox://page/",
    // The font travels inside loader.js; the origin serves nothing a page loads.
    "traycer-sandbox://page/figtree.woff2",
    "traycer-sandbox://page/index.html.map",
    "traycer-sandbox://page/../secrets.txt",
    "traycer-sandbox://page/assets/app.js",
    "traycer-sandbox://other/index.html",
  ])("answers 404 for %s without fetching anything", async (url) => {
    const response = await serve(url);
    expect(response.status).toBe(404);
    expect(state.fetchCalls).toBe(0);
  });

  it("answers 404 when the upstream file cannot be read", async () => {
    state.upstreamOk = false;
    const response = await serve("traycer-sandbox://page/index.html");
    expect(response.status).toBe(404);
  });
});

describe("sandbox base policy", () => {
  it("is the permissive-network, no-form, no-base policy", () => {
    expect(SANDBOX_CONTENT_SECURITY_POLICY).toBe(
      "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'; base-uri 'none'",
    );
  });
});

describe("isSandboxLoaderUrl", () => {
  it.each([
    "traycer-sandbox://page/index.html",
    "traycer-sandbox://page/index.html?perm=camera,microphone",
  ])("accepts %s", (url) => {
    expect(isSandboxLoaderUrl(url)).toBe(true);
  });

  it.each([
    "traycer-sandbox://page/loader.js",
    "traycer-sandbox://page/index.html#frag",
    "traycer-sandbox://page/index.html?other=1",
    "traycer-sandbox://page/index.html?perm=camera&x=1",
    "traycer-sandbox://elsewhere/index.html",
    "https://page/index.html",
    "not a url",
  ])("rejects %s", (url) => {
    expect(isSandboxLoaderUrl(url)).toBe(false);
  });
});

describe("sandboxDeclaredGrants", () => {
  it("maps only the permission enum to Electron grants", () => {
    const grants = sandboxDeclaredGrants(
      "traycer-sandbox://page/index.html?perm=camera,microphone,geolocation,clipboard-write",
    );
    expect([...grants].sort()).toEqual([
      "clipboard-sanitized-write",
      "geolocation",
      "media:audio",
      "media:video",
    ]);
  });

  it("ignores unknown names", () => {
    const grants = sandboxDeclaredGrants(
      "traycer-sandbox://page/index.html?perm=camera,fullscreen,clipboard-read,,",
    );
    expect([...grants]).toEqual(["media:video"]);
  });

  it("grants nothing without a perm query or for a non-loader URL", () => {
    expect(
      sandboxDeclaredGrants("traycer-sandbox://page/index.html").size,
    ).toBe(0);
    expect(
      sandboxDeclaredGrants("traycer-sandbox://page/loader.js?perm=camera")
        .size,
    ).toBe(0);
  });
});
