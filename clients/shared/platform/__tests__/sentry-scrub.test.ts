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
});
