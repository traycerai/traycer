import { describe, expect, it } from "vitest";
import {
  type ClientSentryEvent,
  scrubSentryBreadcrumbInPlace,
  scrubSentryEventInPlace,
} from "../sentry-scrub";

describe("shared client Sentry scrub", () => {
  it("redacts the exception message an unhandled error uploads", () => {
    const event: ClientSentryEvent = {
      exception: {
        values: [{ value: "refresh failed: Cookie: sessionid=abc123" }],
      },
    };
    scrubSentryEventInPlace(event);
    expect(event.exception?.values?.[0]?.value).toBe(
      "refresh failed: Cookie: <redacted>",
    );
  });

  it("redacts extra and contexts, by key and by value", () => {
    const event: ClientSentryEvent = {
      message: "sync failed for csrftoken=zzz",
      extra: { authorization: "Bearer abc.def", note: "?access_token=t1" },
      contexts: { app: { arg: 'password: "hunter2"' } },
    };
    scrubSentryEventInPlace(event);
    expect(event.message).toBe("sync failed for csrftoken=<redacted>");
    expect(event.extra?.["authorization"]).toBe("<redacted>");
    expect(event.extra?.["note"]).toBe("?access_token=<redacted>");
    expect(event.contexts?.["app"]).toEqual({ arg: "password: <redacted>" });
  });

  it("redacts indexed tags and strips request cookies, headers and query", () => {
    const event: ClientSentryEvent = {
      tags: { endpoint: "https://a.test/x?sig=s", authorization: "Bearer t" },
      request: {
        url: "https://a.test/x?sig=s",
        query_string: "sig=s&sessionid=abc",
        cookies: { sid: "abc" },
        headers: { cookie: "sessionid=abc" },
        data: { note: "csrftoken=zzz" },
      },
    };
    scrubSentryEventInPlace(event);
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
    scrubSentryBreadcrumbInPlace(breadcrumb);
    expect(breadcrumb.message).toBe(
      "GET https://a.test/x?sig=<redacted> failed, sessionid=<redacted>",
    );
    expect(breadcrumb.data.url).toBe("https://a.test/x");
  });

  it("reduces a fetch breadcrumb URL that carries a sign-in code in its query", () => {
    // The mobile link-login flow puts the one-time sign-in code in the query
    // string (`clients/shared/auth/link-login.ts`), and the browser SDK
    // records the full fetch URL in a breadcrumb.
    const breadcrumb = {
      data: {
        url: "https://authn.test/api/v3/auth/link/status?code=ABCD-1234",
      },
    };
    scrubSentryBreadcrumbInPlace(breadcrumb);
    expect(breadcrumb.data.url).toBe(
      "https://authn.test/api/v3/auth/link/status",
    );
  });

  describe("home-folder names", () => {
    function buildEvent(name: string, winName: string): ClientSentryEvent {
      return {
        breadcrumbs: [
          {
            message: `Worker thread errored with 'Cannot find module '/Users/${name}/.traycer/host/install/host-runtime/spawn-broker-worker.cjs''`,
            data: { spawnfile: `/home/${name}/.traycer/bin/tool` },
          },
        ],
        exception: {
          values: [
            {
              value: `ENOENT C:\\Users\\${winName}\\.traycer\\x`,
              stacktrace: {
                frames: [
                  {
                    filename: `/Users/${name}/.traycer/host/install/host-main.cjs`,
                    abs_path: `/Users/${name}/.traycer/host/install/host-main.cjs`,
                  },
                  {
                    filename: `/home/${name}/.traycer/host/install/host-main.cjs`,
                    abs_path: `/home/${name}/.traycer/host/install/host-main.cjs`,
                  },
                  {
                    filename: `C:\\Users\\${winName}\\.traycer\\host\\install\\host-main.cjs`,
                    abs_path: `C:\\Users\\${winName}\\.traycer\\host\\install\\host-main.cjs`,
                  },
                ],
              },
            },
          ],
        },
      };
    }

    it("redacts the folder name in breadcrumbs, messages and every stack frame", () => {
      const event = buildEvent("synthetic-user", "SyntheticUser");
      scrubSentryEventInPlace(event);
      expect(event.breadcrumbs?.[0]?.message).toBe(
        "Worker thread errored with 'Cannot find module '/Users/<redacted>/.traycer/host/install/host-runtime/spawn-broker-worker.cjs''",
      );
      expect(event.breadcrumbs?.[0]?.data?.["spawnfile"]).toBe(
        "/home/<redacted>/.traycer/bin/tool",
      );
      const value = event.exception?.values?.[0];
      expect(value?.value).toBe("ENOENT C:\\Users\\<redacted>\\.traycer\\x");
      expect(value?.stacktrace?.frames).toEqual([
        {
          filename: "/Users/<redacted>/.traycer/host/install/host-main.cjs",
          abs_path: "/Users/<redacted>/.traycer/host/install/host-main.cjs",
        },
        {
          filename: "/home/<redacted>/.traycer/host/install/host-main.cjs",
          abs_path: "/home/<redacted>/.traycer/host/install/host-main.cjs",
        },
        {
          filename:
            "C:\\Users\\<redacted>\\.traycer\\host\\install\\host-main.cjs",
          abs_path:
            "C:\\Users\\<redacted>\\.traycer\\host\\install\\host-main.cjs",
        },
      ]);
      const json = JSON.stringify(event);
      expect(json).not.toContain("synthetic-user");
      expect(json).not.toContain("SyntheticUser");
    });

    it("groups events that differ only by the home name, and is idempotent", () => {
      const a = buildEvent("synthetic-user", "SyntheticUser");
      const b = buildEvent("other-synthetic-user", "OtherSyntheticUser");
      scrubSentryEventInPlace(a);
      scrubSentryEventInPlace(b);
      expect(a.exception?.values?.[0]?.stacktrace?.frames).toEqual(
        b.exception?.values?.[0]?.stacktrace?.frames,
      );
      const once = JSON.stringify(a);
      scrubSentryEventInPlace(a);
      expect(JSON.stringify(a)).toBe(once);
    });

    it("redacts the folder name in a breadcrumb file URL", () => {
      const breadcrumb = {
        data: {
          url: "file:///Users/synthetic-user/Applications/Traycer.app/x.html",
        },
      };
      scrubSentryBreadcrumbInPlace(breadcrumb);
      expect(breadcrumb.data.url).toBe(
        "null/Users/<redacted>/Applications/Traycer.app/x.html",
      );
    });
  });
});
