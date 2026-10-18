/**
 * The token reaches Capacitor's native routes on the native server, through
 * both request paths Capacitor's patches call, and nowhere else - including
 * when the document's origin is not the native server's (iOS live reload).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_HTTP_TOKEN_GLOBAL,
  NATIVE_HTTP_TOKEN_PARAM,
  installNativeHttpToken,
  withNativeHttpToken,
} from "../src/web/native-http-token";

const TOKEN = "a".repeat(64);
/** The native server under iOS live reload, while the document is jsdom's. */
const NATIVE = "capacitor://localhost";
const NATIVE_PROXY = `${NATIVE}/_capacitor_http_interceptor_?u=https%3A%2F%2Fapi.example.com%2Fx`;
const DOCUMENT_PROXY = `${location.origin}/_capacitor_http_interceptor_?u=https%3A%2F%2Fapi.example.com%2Fx`;

function tokenOf(url: string): string | null {
  return new URL(url).searchParams.get(NATIVE_HTTP_TOKEN_PARAM);
}

function stubCapacitor(serverUrl: string): void {
  Reflect.set(window, NATIVE_HTTP_TOKEN_GLOBAL, TOKEN);
  Reflect.set(window, "Capacitor", { getServerUrl: () => serverUrl });
}

afterEach(() => {
  for (const name of [
    NATIVE_HTTP_TOKEN_GLOBAL,
    "Capacitor",
    "CapacitorWebFetch",
    "CapacitorWebXMLHttpRequest",
  ]) {
    Reflect.deleteProperty(window, name);
  }
});

describe("withNativeHttpToken", () => {
  it("adds the token to a native route on the native server", () => {
    const url = withNativeHttpToken(NATIVE_PROXY, TOKEN, NATIVE, location.href);
    expect(tokenOf(url)).toBe(TOKEN);
    expect(new URL(url).searchParams.get("u")).toBe(
      "https://api.example.com/x",
    );
  });

  it("adds it on the document's origin when that is the native server", () => {
    const url = withNativeHttpToken(
      DOCUMENT_PROXY,
      TOKEN,
      location.origin,
      location.href,
    );
    expect(tokenOf(url)).toBe(TOKEN);
  });

  it.each([
    ["the document origin when the native server differs", DOCUMENT_PROXY],
    [
      "a relative native path, which resolves to the document",
      "/_capacitor_file_/x",
    ],
    ["another origin", "https://evil.example/_capacitor_http_interceptor_?u=x"],
    [
      "a native-server path that is not a native route",
      `${NATIVE}/assets/a.js`,
    ],
  ])("leaves %s alone", (_label, url) => {
    expect(withNativeHttpToken(url, TOKEN, NATIVE, location.href)).toBe(url);
  });
});

describe("installNativeHttpToken", () => {
  it("does nothing without a token, as in any sandbox frame", () => {
    const fetchImpl = vi.fn();
    Reflect.set(window, "Capacitor", { getServerUrl: () => NATIVE });
    Reflect.set(window, "CapacitorWebFetch", fetchImpl);
    expect(installNativeHttpToken(window)).toBe(false);
    expect(Reflect.get(window, "CapacitorWebFetch")).toBe(fetchImpl);
  });

  it("does nothing without Capacitor's native server URL", () => {
    Reflect.set(window, NATIVE_HTTP_TOKEN_GLOBAL, TOKEN);
    expect(installNativeHttpToken(window)).toBe(false);
  });

  it("tokenizes every input shape Capacitor's fetch patch passes", () => {
    // The document's own origin, so `Request` (which needs a fetchable
    // scheme in jsdom) can carry it too.
    stubCapacitor(location.origin);
    const seen: string[] = [];
    Reflect.set(window, "CapacitorWebFetch", (input: unknown) => {
      if (typeof input === "string") seen.push(input);
      else if (input instanceof URL) seen.push(input.href);
      else if (input instanceof Request) seen.push(input.url);
    });
    expect(installNativeHttpToken(window)).toBe(true);
    const fetchVia = Reflect.get(window, "CapacitorWebFetch");
    if (typeof fetchVia !== "function") throw new Error("not wrapped");
    fetchVia(DOCUMENT_PROXY, undefined);
    fetchVia(new URL(DOCUMENT_PROXY), undefined);
    fetchVia(new Request(DOCUMENT_PROXY), undefined);
    expect(seen.map(tokenOf)).toEqual([TOKEN, TOKEN, TOKEN]);
  });

  it("tokenizes the XHR open Capacitor's patch calls, on the native server only", () => {
    stubCapacitor(NATIVE);
    const opened: unknown[] = [];
    Reflect.set(window, "CapacitorWebXMLHttpRequest", {
      open: (_method: unknown, url: unknown) => opened.push(url),
    });
    installNativeHttpToken(window);
    const xhr: unknown = Reflect.get(window, "CapacitorWebXMLHttpRequest");
    const open =
      typeof xhr === "object" && xhr !== null ? Reflect.get(xhr, "open") : null;
    if (typeof open !== "function") throw new Error("not wrapped");
    Reflect.apply(open, new XMLHttpRequest(), ["GET", NATIVE_PROXY]);
    Reflect.apply(open, new XMLHttpRequest(), ["GET", DOCUMENT_PROXY]);
    expect(opened).toEqual([
      withNativeHttpToken(NATIVE_PROXY, TOKEN, NATIVE, location.href),
      DOCUMENT_PROXY,
    ]);
  });
});
