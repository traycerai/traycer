import { describe, expect, it } from "vitest";
import type { Breadcrumb, ErrorEvent } from "@sentry/browser";
import { sentryInitOptions, type SentryBakedConfig } from "../src/sentry";

const environments: ReadonlyArray<SentryBakedConfig["environment"]> = [
  "dev",
  "staging",
  "production",
];

describe("sentryInitOptions", () => {
  it.each(environments)(
    "returns null for an empty DSN in the %s environment",
    (environment) => {
      const config: SentryBakedConfig = { sentryDsn: "", environment };
      expect(sentryInitOptions(config)).toBeNull();
    },
  );

  it("returns init options carrying the DSN and environment through unchanged", () => {
    const config: SentryBakedConfig = {
      sentryDsn: "https://example.ingest.sentry.io/1",
      environment: "staging",
    };

    const options = sentryInitOptions(config);

    expect(options).not.toBeNull();
    expect(options).toMatchObject({
      dsn: config.sentryDsn,
      environment: config.environment,
      attachStacktrace: true,
      sendDefaultPii: false,
    });
  });

  it("omits release and tracing keys rather than leaving them undefined", () => {
    const config: SentryBakedConfig = {
      sentryDsn: "https://example.ingest.sentry.io/1",
      environment: "production",
    };

    const options = sentryInitOptions(config);

    expect(options).not.toBeNull();
    expect(options).not.toHaveProperty("release");
    expect(options).not.toHaveProperty("tracesSampleRate");
    expect(options).not.toHaveProperty("profilesSampleRate");
  });

  it("installs the shared scrub as its beforeSend hook", () => {
    const options = sentryInitOptions({
      sentryDsn: "https://example.ingest.sentry.io/1",
      environment: "production",
    });
    expect(options).not.toBeNull();
    const beforeSend = options?.beforeSend;
    expect(beforeSend).toBeTypeOf("function");
    if (beforeSend === undefined) return;
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [{ value: "refresh failed: Cookie: sessionid=abc123" }],
      },
    };
    const sent = beforeSend(event, {});
    expect(sent).toBe(event);
    expect(event.exception?.values?.[0]?.value).toBe(
      "refresh failed: Cookie: <redacted>",
    );
  });

  it("reduces a fetch breadcrumb URL to origin and path at record time", () => {
    const options = sentryInitOptions({
      sentryDsn: "https://example.ingest.sentry.io/1",
      environment: "staging",
    });
    expect(options).not.toBeNull();
    const beforeBreadcrumb = options?.beforeBreadcrumb;
    expect(beforeBreadcrumb).toBeTypeOf("function");
    if (beforeBreadcrumb === undefined) return;
    // The link-login sign-in code travels in a query string; the browser SDK
    // records the full fetch URL. The hook must drop the query.
    const breadcrumb: Breadcrumb = {
      category: "fetch",
      data: {
        method: "GET",
        url: "https://authn.test/api/v3/auth/link/status?code=ABCD-1234",
        status_code: 200,
      },
    };
    const kept = beforeBreadcrumb(breadcrumb, {});
    expect(kept).toBe(breadcrumb);
    expect(breadcrumb.data?.["url"]).toBe(
      "https://authn.test/api/v3/auth/link/status",
    );
  });

  it("registers the transaction and span hooks even with no tracing", () => {
    const options = sentryInitOptions({
      sentryDsn: "https://example.ingest.sentry.io/1",
      environment: "dev",
    });
    expect(options?.beforeSendTransaction).toBeTypeOf("function");
    expect(options?.beforeSendSpan).toBeTypeOf("function");
  });

  it("does not mutate the config object passed in", () => {
    const config: SentryBakedConfig = Object.freeze({
      sentryDsn: "https://example.ingest.sentry.io/1",
      environment: "dev" as const,
    });

    expect(() => sentryInitOptions(config)).not.toThrow();
  });
});
