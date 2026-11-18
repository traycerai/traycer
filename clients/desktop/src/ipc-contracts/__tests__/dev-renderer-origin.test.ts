import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEV_RENDERER_URL,
  devRendererOriginFromEnv,
  devRendererUrlFromEnv,
  TRAYCER_DESKTOP_DEV_URL_ENV,
} from "../dev-renderer-origin";

describe("dev renderer origin helpers", () => {
  it("uses the fixed dev renderer URL when no dynamic URL is provided", () => {
    expect(devRendererUrlFromEnv({})).toBe(DEFAULT_DEV_RENDERER_URL);
    expect(devRendererOriginFromEnv({})).toBe(DEFAULT_DEV_RENDERER_URL);
  });

  it("accepts dynamic loopback renderer origins", () => {
    expect(
      devRendererUrlFromEnv({
        [TRAYCER_DESKTOP_DEV_URL_ENV]: "http://localhost:21005",
      }),
    ).toBe("http://localhost:21005");
    expect(
      devRendererUrlFromEnv({
        [TRAYCER_DESKTOP_DEV_URL_ENV]: "http://127.0.0.1:21005/",
      }),
    ).toBe("http://127.0.0.1:21005");
  });

  it("rejects non-loopback or non-origin renderer URLs", () => {
    expect(() =>
      devRendererUrlFromEnv({
        [TRAYCER_DESKTOP_DEV_URL_ENV]: "https://localhost:21005",
      }),
    ).toThrow(/must use http/);
    expect(() =>
      devRendererUrlFromEnv({
        [TRAYCER_DESKTOP_DEV_URL_ENV]: "http://example.com:21005",
      }),
    ).toThrow(/loopback/);
    expect(() =>
      devRendererUrlFromEnv({
        [TRAYCER_DESKTOP_DEV_URL_ENV]: "http://localhost:21005/path",
      }),
    ).toThrow(/origin URL/);
  });
});
