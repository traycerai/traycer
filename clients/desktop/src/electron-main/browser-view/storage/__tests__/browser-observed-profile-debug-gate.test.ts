import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserStorageCookie } from "@traycer/protocol/host/browser/contracts";

/**
 * Ticket 04: `TRAYCER_DEBUG_DROP_HOST_OBSERVATIONS` must never do anything on
 * a shipped build. `isDevBuild` is a module-scope constant baked at import
 * time, so the "on" behaviour (matching, seed bypass, list normalisation) is
 * pinned against the real, dev-slot `isDevBuild` in
 * `browser-observed-profile.test.ts`'s static-import suite; only the OFF
 * branch needs the constant mocked false, which needs a fresh module graph
 * per test rather than that file's shared, statically-imported harness.
 */
describe("observed sign-in debug drop is dev-build-only (ticket 04)", () => {
  afterEach(() => {
    delete process.env.TRAYCER_DEBUG_DROP_HOST_OBSERVATIONS;
    vi.doUnmock("../../../../config");
    vi.doUnmock("../../../app/logger");
    vi.resetModules();
  });

  it("never drops an observed frame on a shipped build, even with a matching drop-list entry", async () => {
    process.env.TRAYCER_DEBUG_DROP_HOST_OBSERVATIONS = "example.com";
    vi.resetModules();
    vi.doMock("../../../../config", () => ({ isDevBuild: false }));
    vi.doMock("../../../app/logger", () => ({
      isDebugEnabled: () => true,
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      sanitizeLogFields: (fields: Record<string, unknown>) => fields,
      describeLogError: (error: unknown) => String(error),
    }));

    const { applyBrowserObservedProfile, BrowserObservedConnectionGovernor } =
      await import("../browser-observed-profile");
    const { BrowserJarSerializer } = await import("../browser-jar-serializer");
    const { FakeCookieJar } = await import("./cookie-jar-fixture");

    const jar = new FakeCookieJar();
    const serializer = new BrowserJarSerializer();
    const governor = new BrowserObservedConnectionGovernor(() => Date.now());
    const cookie: BrowserStorageCookie = {
      name: "sid",
      value: "sid-value",
      domain: "example.com",
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
      partitionKey: null,
    };

    const result = await applyBrowserObservedProfile(
      {
        source: "observed",
        connectionId: "connection-1",
        hostId: "host-1",
        domain: "example.com",
        cookies: [cookie],
      },
      {
        now: () => Date.now(),
        isForgottenPendingAck: () => false,
        isHeadlessOriginKey: () => false,
        claimHeadlessOriginKeys: () => Promise.resolve(),
        noteAppliedKeys: () => undefined,
        releaseHeadlessOriginKeys: () => Promise.resolve(),
        getTargetJar: () => ({ session: { cookies: jar }, durableJar: true }),
        serializeOnDomain: (domain, action) =>
          serializer.runOnDomain(domain, action),
        governor,
      },
    );

    expect(result.outcome).toBe("applied");
    expect(jar.names()).toEqual(["sid"]);
  });
});
