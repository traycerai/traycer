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

    it("redacts a multiword home name a quote closes, and each of two quoted paths", () => {
      const event: ClientSentryEvent = {
        breadcrumbs: [{ message: "copy '/home/syn a' to '/home/syn b/x'" }],
        exception: {
          values: [
            {
              value:
                "ENOENT: no such file or directory, scandir 'C:\\Users\\Syn Thetic'",
            },
          ],
        },
      };
      scrubSentryEventInPlace(event);
      expect(event.exception?.values?.[0]?.value).toBe(
        "ENOENT: no such file or directory, scandir 'C:\\Users\\<redacted>'",
      );
      expect(event.breadcrumbs?.[0]?.message).toBe(
        "copy '/home/<redacted>' to '/home/<redacted>/x'",
      );
    });

    it("keeps a module id with a home segment in a console breadcrumb and still redacts a frame path", () => {
      // The line `appLogger.warn` writes for a failed chunk warm-up.
      const line = `[traycer-log] ${JSON.stringify({
        source: "gui-app",
        level: "warn",
        message: "[warm-route-chunks] chunk warm-up failed",
        fields: {
          module: "@/components/home/landing-draft-surface",
          error: { name: "TypeError", messageLength: 12, stack: null },
        },
      })}`;
      const event: ClientSentryEvent = {
        breadcrumbs: [{ message: line }],
        exception: {
          values: [
            {
              stacktrace: {
                frames: [
                  { filename: "/Users/syn/x.js", abs_path: "/Users/syn/x.js" },
                ],
              },
            },
          ],
        },
      };
      scrubSentryEventInPlace(event);
      expect(event.breadcrumbs?.[0]?.message).toContain(
        "@/components/home/landing-draft-surface",
      );
      expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({
        filename: "/Users/<redacted>/x.js",
        abs_path: "/Users/<redacted>/x.js",
      });
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

    it("redacts the home folder in debug_meta images, matching the frame paths", () => {
      const event: ClientSentryEvent = {
        exception: {
          values: [
            {
              stacktrace: {
                frames: [
                  {
                    filename: "/Users/synthetic-user/.traycer/cli/main.js",
                    abs_path: "/Users/synthetic-user/.traycer/cli/main.js",
                  },
                ],
              },
            },
          ],
        },
        debug_meta: {
          images: [
            {
              type: "sourcemap",
              code_file: "/Users/synthetic-user/.traycer/cli/main.js",
              debug_id: "11111111-1111-4111-8111-111111111111",
            },
            {
              type: "macho",
              code_file:
                "/Users/synthetic-user/Applications/Traycer.app/Contents/MacOS/Traycer",
              debug_file:
                "/Users/synthetic-user/Applications/Traycer.app/Contents/MacOS/Traycer",
              debug_id: "22222222-2222-4222-8222-222222222222",
            },
          ],
        },
      };
      scrubSentryEventInPlace(event);
      const redacted = "/Users/<redacted>/.traycer/cli/main.js";
      const frame = event.exception?.values?.[0]?.stacktrace?.frames?.[0];
      expect(frame?.abs_path).toBe(redacted);
      expect(frame?.filename).toBe(redacted);
      expect(event.debug_meta?.images).toEqual([
        {
          type: "sourcemap",
          code_file: redacted,
          debug_id: "11111111-1111-4111-8111-111111111111",
        },
        {
          type: "macho",
          code_file:
            "/Users/<redacted>/Applications/Traycer.app/Contents/MacOS/Traycer",
          debug_file:
            "/Users/<redacted>/Applications/Traycer.app/Contents/MacOS/Traycer",
          debug_id: "22222222-2222-4222-8222-222222222222",
        },
      ]);
      expect(event.debug_meta?.images?.[0]?.code_file).toBe(frame?.abs_path);
      expect(JSON.stringify(event)).not.toContain("synthetic-user");
    });

    it("redacts a home folder name that contains consecutive spaces", () => {
      const event: ClientSentryEvent = {
        breadcrumbs: [
          {
            message:
              "Cannot find module 'C:\\Users\\Synthetic  User\\.traycer\\cli\\main.js'",
          },
        ],
        exception: {
          values: [
            {
              stacktrace: {
                frames: [
                  {
                    filename:
                      "C:\\Users\\Synthetic  User\\.traycer\\cli\\main.js",
                  },
                ],
              },
            },
          ],
        },
      };
      scrubSentryEventInPlace(event);
      expect(event.breadcrumbs?.[0]?.message).toBe(
        "Cannot find module 'C:\\Users\\<redacted>\\.traycer\\cli\\main.js'",
      );
      expect(
        event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename,
      ).toBe("C:\\Users\\<redacted>\\.traycer\\cli\\main.js");
      expect(JSON.stringify(event)).not.toContain("Synthetic");
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
