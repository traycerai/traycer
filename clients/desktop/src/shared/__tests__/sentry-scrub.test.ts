import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DesktopSentryEvent,
  scrubDesktopBreadcrumbInPlace,
  scrubDesktopSentryEventInPlace,
} from "../sentry-scrub";

const DESKTOP_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
/** The renderer library is the fifth place these patterns used to live. */
const GUI_APP_SRC = path.resolve(DESKTOP_SRC, "..", "..", "gui-app", "src");

describe("shared desktop Sentry scrub", () => {
  it("redacts the exception message an unhandled renderer error uploads", () => {
    const event: DesktopSentryEvent = {
      exception: {
        values: [{ value: "refresh failed: Cookie: sessionid=abc123" }],
      },
    };
    scrubDesktopSentryEventInPlace(event);
    expect(event.exception?.values?.[0]?.value).toBe(
      "refresh failed: Cookie: <redacted>",
    );
  });

  it("redacts extra and contexts, by key and by value", () => {
    const event: DesktopSentryEvent = {
      message: "sync failed for csrftoken=zzz",
      extra: { authorization: "Bearer abc.def", note: "?access_token=t1" },
      contexts: { app: { arg: 'password: "hunter2"' } },
    };
    scrubDesktopSentryEventInPlace(event);
    expect(event.message).toBe("sync failed for csrftoken=<redacted>");
    expect(event.extra?.["authorization"]).toBe("<redacted>");
    expect(event.extra?.["note"]).toBe("?access_token=<redacted>");
    expect(event.contexts?.["app"]).toEqual({ arg: "password: <redacted>" });
  });

  it("redacts indexed tags and strips request cookies, headers and query", () => {
    const event: DesktopSentryEvent = {
      tags: { endpoint: "https://a.test/x?sig=s", authorization: "Bearer t" },
      request: {
        url: "https://a.test/x?sig=s",
        query_string: "sig=s&sessionid=abc",
        cookies: { sid: "abc" },
        headers: { cookie: "sessionid=abc" },
        data: { note: "csrftoken=zzz" },
      },
    };
    scrubDesktopSentryEventInPlace(event);
    expect(event.tags?.["endpoint"]).toBe("https://a.test/x?sig=<redacted>");
    expect(event.tags?.["authorization"]).toBe("<redacted>");
    expect(event.request?.url).toBe("https://a.test/x");
    expect(event.request?.query_string).toBe(
      "sig=<redacted>&sessionid=<redacted>",
    );
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.headers).toBeUndefined();
    expect(event.request?.data).toEqual({ note: "csrftoken=<redacted>" });
  });

  it("redacts a console breadcrumb's joined arguments and reduces its URL", () => {
    const breadcrumb = {
      message: "GET https://a.test/x?sig=s failed, sessionid=abc",
      data: { url: "https://a.test/x?sig=s#access_token=t" },
    };
    scrubDesktopBreadcrumbInPlace(breadcrumb);
    expect(breadcrumb.message).toBe(
      "GET https://a.test/x?sig=<redacted> failed, sessionid=<redacted>",
    );
    expect(breadcrumb.data.url).toBe("https://a.test/x");
  });

  /**
   * Ruling 3: the renderer used to install only the breadcrumb URL rewrite, so
   * every `exception.value` and console breadcrumb argument uploaded raw. The
   * hooks live in `Sentry.init`'s options object, which is why this is pinned
   * at the source rather than by driving the SDK.
   */
  it("wires both hooks into the renderer-shell Sentry init", async () => {
    const source = await fs.readFile(
      path.join(DESKTOP_SRC, "renderer-shell", "main.tsx"),
      "utf8",
    );
    expect(source).toContain("scrubDesktopSentryEventInPlace(event)");
    expect(source).toContain("scrubDesktopBreadcrumbInPlace(breadcrumb)");
  });

  /**
   * Ruling 5: the detection set is a security control and must not differ by
   * call site. Every desktop redaction path reaches
   * `@traycer/protocol/utils/text/redaction`; a module that declares a
   * credential pattern of its own has, by definition, forked the set.
   */
  it("declares no credential pattern outside the shared leaf", async () => {
    const offenders: string[] = [];
    const stack = [DESKTOP_SRC, GUI_APP_SRC];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const source = await fs.readFile(full, "utf8");
        if (
          /\b(?:SENSITIVE_(?:KEY|QUERY_PARAM|INLINE_VALUE)_PATTERN|BEARER_PATTERN|BASIC_AUTH_PATTERN|TOKEN_SHAPE_PATTERN|SESSION_COOKIE_PATTERN|COOKIE_HEADER_PATTERN|AUTHORIZATION_HEADER_PATTERN)\s*=/.test(
            source,
          )
        ) {
          offenders.push(full);
        }
      }
    }
    expect(
      offenders,
      `these modules define their own credential patterns instead of importing @traycer/protocol/utils/text/redaction:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
