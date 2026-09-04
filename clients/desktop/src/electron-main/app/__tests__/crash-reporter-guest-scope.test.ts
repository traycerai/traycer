import { describe, expect, it } from "vitest";
import { desktopSentryBeforeSend } from "../crash-reporter-guest-scope";
import {
  scrubSentryBreadcrumbInPlace,
  scrubSentrySpanInPlace,
  scrubSentryTransactionInPlace,
} from "@traycer-clients/shared/platform/sentry-scrub";

/** A minidump event exactly as `sentryMinidumpIntegration` assembles it. */
function nativeCrashEvent(processTag: string): {
  platform: string;
  tags: { [key: string]: unknown };
  contexts: { [key: string]: unknown };
} {
  return {
    platform: "native",
    tags: {
      "event.environment": "native",
      "event.process": processTag,
      "exit.reason": "crashed",
    },
    contexts: {
      electron: {
        crashed_url: "https://mail.example.com/inbox?access_token=abc123",
      },
    },
  };
}

/** The hint the SDK passes alongside it: the dump itself rides here. */
const minidumpHint = {
  attachments: [{ filename: "dump.dmp", data: new Uint8Array([1, 2, 3]) }],
};

describe("desktopSentryBeforeSend", () => {
  it("drops every renderer minidump, ours included", () => {
    // No renderer dump is attributable: `sendNativeCrashes` loads all pending
    // dumps and stamps them with the currently crashed renderer's identity.
    for (const processTag of ["renderer", "unknown", "app-shell"]) {
      expect(
        desktopSentryBeforeSend(nativeCrashEvent(processTag), minidumpHint),
      ).toBeNull();
    }
  });

  it("keeps non-renderer native crashes", () => {
    for (const processTag of ["browser", "gpu", "utility"]) {
      const event = nativeCrashEvent(processTag);
      expect(desktopSentryBeforeSend(event, minidumpHint)).toBe(event);
    }
  });

  it("drops on the `native` platform marker alone", () => {
    expect(
      desktopSentryBeforeSend(
        { platform: "native", tags: { "event.process": "renderer" } },
        {},
      ),
    ).toBeNull();
  });

  it("drops on the `event.environment` tag alone", () => {
    expect(
      desktopSentryBeforeSend(
        {
          tags: { "event.environment": "native", "event.process": "renderer" },
        },
        {},
      ),
    ).toBeNull();
  });

  it("drops on the `.dmp` attachment alone", () => {
    // The dump itself: the marker that stays true if a future SDK stops
    // stamping either tag above.
    expect(desktopSentryBeforeSend({ tags: {} }, minidumpHint)).toBeNull();
  });

  it("never drops an ordinary JavaScript error event", () => {
    const event = { tags: { origin: "uncaughtException" } };
    expect(desktopSentryBeforeSend(event, {})).toBe(event);
  });

  it("scrubs the `crashed_url` the SDK writes into `contexts`", () => {
    const event = nativeCrashEvent("browser");
    expect(desktopSentryBeforeSend(event, minidumpHint)).toBe(event);
    expect(event.contexts["electron"]).toEqual({
      crashed_url: "https://mail.example.com/inbox?access_token=<redacted>",
    });
  });

  it("redacts an `extra` key by name whatever its value looks like", () => {
    const event = {
      tags: {},
      extra: { authorization: "Basic dXNlcjpwYXNzd29yZDEyMw==" },
    };
    expect(desktopSentryBeforeSend(event, {})).toBe(event);
    expect(event.extra.authorization).toBe("<redacted>");
  });

  it("scrubs the exception values `captureException` fills", () => {
    const event = {
      tags: {},
      message: "refresh failed for token=abcdef",
      exception: {
        values: [
          { value: "POST /oauth/token?code=4/0AY0e-g7 -> 401" },
          { value: "Bearer abc123.def456-ghi rejected" },
        ],
      },
    };
    expect(desktopSentryBeforeSend(event, {})).toBe(event);
    expect(event.message).toBe("refresh failed for token=<redacted>");
    expect(event.exception.values.map((entry) => entry.value)).toEqual([
      "POST /oauth/token?code=<redacted> -> 401",
      "Bearer <redacted> rejected",
    ]);
  });

  it("scrubs the `extra.args` funnel, breadcrumb URLs and breadcrumb text", () => {
    const event = {
      tags: {},
      extra: { args: ["GET /v1/x?access_token=abc123", { cookie: "sid=a" }] },
      breadcrumbs: [
        {
          message: "electron.renderer.load-url token=abcdef",
          data: { url: "https://mail.example.com/inbox?sig=abc", id: 4 },
        },
      ],
    };
    expect(desktopSentryBeforeSend(event, {})).toBe(event);
    expect(event.extra.args).toEqual([
      "GET /v1/x?access_token=<redacted>",
      { cookie: "<redacted>" },
    ]);
    expect(event.breadcrumbs[0]).toEqual({
      message: "electron.renderer.load-url token=<redacted>",
      data: { url: "https://mail.example.com/inbox", id: 4 },
    });
  });
});

describe("scrubSentryBreadcrumbInPlace", () => {
  it("reduces the URL at record time, before the scope is persisted", () => {
    const breadcrumb = {
      message: "electron.renderer.load-url",
      data: { url: "https://x.test:8443/a/b?sig=s#access_token=t", id: 2 },
    };
    scrubSentryBreadcrumbInPlace(breadcrumb);
    expect(breadcrumb.data.url).toBe("https://x.test:8443/a/b");
  });

  it("scrubs the breadcrumb message, which no URL reducer touches", () => {
    const breadcrumb = { message: "auth Bearer abc123.def456-ghi" };
    scrubSentryBreadcrumbInPlace(breadcrumb);
    expect(breadcrumb.message).toBe("auth Bearer <redacted>");
  });
});

describe("scrubSentryTransactionInPlace", () => {
  it("reduces the root span's URL attributes and the transaction name", () => {
    const event = {
      transaction: "GET /v1/pay?token=abc",
      contexts: {
        trace: {
          op: "http.server",
          data: {
            "url.full": "https://api.test/v1/pay?token=abc&page=2",
            "http.url": "https://api.test/v1/pay?token=abc",
            "http.target": "/v1/pay?token=abc",
            "url.query": "?token=abc",
            "http.method": "GET",
          },
        },
      },
    };
    scrubSentryTransactionInPlace(event);
    expect(event.transaction).toBe("GET /v1/pay?token=<redacted>");
    expect(event.contexts.trace.data).toEqual({
      "url.full": "https://api.test/v1/pay",
      "http.url": "https://api.test/v1/pay",
      "http.target": "/v1/pay",
      "http.method": "GET",
    });
  });
});

describe("scrubSentrySpanInPlace", () => {
  it("reduces the outgoing-fetch URL a child span carries", () => {
    const span = {
      description: "GET https://vendor.test/x?access_token=abc123",
      data: {
        "url.full": "https://vendor.test/x?access_token=abc123",
        "url.query": "?access_token=abc123",
      },
    };
    scrubSentrySpanInPlace(span);
    expect(span.description).toBe(
      "GET https://vendor.test/x?access_token=<redacted>",
    );
    expect(span.data).toEqual({ "url.full": "https://vendor.test/x" });
  });
});
