import { describe, expect, it } from "vitest";
import {
  browserSessionsClientFrameSchema,
  browserSessionsServerFrameSchema,
} from "@traycer/protocol/host/browser/contracts";
import { browserSessionsClientFrameSchemaV10 } from "@traycer/protocol/host/browser/contracts-v1";
import {
  BROWSER_SESSIONS_V1_NO_WINDOW_BINDING_REASON,
  liftBrowserSessionsServerFrameFromV10,
  projectBrowserSessionsClientFrameToV10,
} from "../browser-contracts-v1-bridge";

/**
 * Pins the round-trip the bridge exists to guarantee: every server frame it
 * LIFTS still satisfies the live schema, and every client frame it PROJECTS
 * still satisfies the frozen `@1` schema. Cheap, and it catches a future
 * live-line field leaking onto the frozen wire (a strict-schema silent drop)
 * before a live host / v1.3.0 host pairing ever finds it.
 */
describe("browser-contracts-v1-bridge", () => {
  const v10Session = {
    sessionId: "browser-session-1",
    epicId: "epic-1",
    hostId: "host-1",
    profile: "primary" as const,
    lastActivityAt: 1,
    runtime: { kind: "headless" as const, revision: 0 },
    tabs: [
      {
        tabId: "browser-tab-1",
        url: "https://example.com",
        originTier: "external" as const,
        status: "ready" as const,
        title: "Example",
        viewed: false,
        drivenBy: [],
      },
    ],
  };

  it("lifts snapshot into the live scope+boundWindowId shape", () => {
    const lifted = liftBrowserSessionsServerFrameFromV10({
      kind: "snapshot",
      hasBinaryPayload: false,
      sessions: [v10Session],
    });
    expect(() => browserSessionsServerFrameSchema.parse(lifted)).not.toThrow();
    if (lifted.kind !== "snapshot") throw new Error("expected snapshot");
    expect(lifted.sessions[0].scope).toEqual({
      kind: "epic",
      epicId: "epic-1",
    });
    expect(lifted.sessions[0].tabs[0].boundWindowId).toBeNull();
  });

  it("lifts sessionCreated and sessionUpdated the same way", () => {
    for (const kind of ["sessionCreated", "sessionUpdated"] as const) {
      const lifted = liftBrowserSessionsServerFrameFromV10({
        kind,
        hasBinaryPayload: false,
        session: v10Session,
      });
      expect(() =>
        browserSessionsServerFrameSchema.parse(lifted),
      ).not.toThrow();
      if (lifted.kind !== kind) throw new Error(`expected ${kind}`);
      expect(lifted.session.scope).toEqual({ kind: "epic", epicId: "epic-1" });
      expect(lifted.session.tabs[0].boundWindowId).toBeNull();
    }
  });

  it("lifts tabOpened's absent opener to openerTabId: null", () => {
    const lifted = liftBrowserSessionsServerFrameFromV10({
      kind: "tabOpened",
      hasBinaryPayload: false,
      sessionId: "browser-session-1",
      tabId: "browser-tab-1",
      source: "page",
    });
    expect(() => browserSessionsServerFrameSchema.parse(lifted)).not.toThrow();
    if (lifted.kind !== "tabOpened") throw new Error("expected tabOpened");
    expect(lifted.openerTabId).toBeNull();
  });

  it("lifts openTabResult's ok:true arm to handoffToken: null, and leaves ok:false untouched", () => {
    const liftedOk = liftBrowserSessionsServerFrameFromV10({
      kind: "openTabResult",
      hasBinaryPayload: false,
      requestId: "open-1",
      result: {
        ok: true,
        sessionId: "browser-session-1",
        tabId: "browser-tab-1",
      },
    });
    expect(() =>
      browserSessionsServerFrameSchema.parse(liftedOk),
    ).not.toThrow();
    if (liftedOk.kind !== "openTabResult")
      throw new Error("expected openTabResult");
    if (!liftedOk.result.ok) throw new Error("expected an ok:true result");
    expect(liftedOk.result.handoffToken).toBeNull();

    const liftedFailed = liftBrowserSessionsServerFrameFromV10({
      kind: "openTabResult",
      hasBinaryPayload: false,
      requestId: "open-2",
      result: { ok: false, reason: "session is closing" },
    });
    expect(() =>
      browserSessionsServerFrameSchema.parse(liftedFailed),
    ).not.toThrow();
    if (liftedFailed.kind !== "openTabResult") {
      throw new Error("expected openTabResult");
    }
    if (liftedFailed.result.ok) throw new Error("expected an ok:false result");
    expect(liftedFailed.result.reason).toBe("session is closing");
  });

  it("passes an identical-shape frame kind through unchanged", () => {
    const lifted = liftBrowserSessionsServerFrameFromV10({
      kind: "sessionClosed",
      hasBinaryPayload: false,
      sessionId: "browser-session-1",
      reason: "completed",
    });
    expect(() => browserSessionsServerFrameSchema.parse(lifted)).not.toThrow();
    expect(lifted).toEqual({
      kind: "sessionClosed",
      hasBinaryPayload: false,
      sessionId: "browser-session-1",
      reason: "completed",
    });
  });

  it("projects electronTabLifecycleReady by dropping desktopWindowId, which the frozen line has no reader for", () => {
    const projected = projectBrowserSessionsClientFrameToV10(
      browserSessionsClientFrameSchema.parse({
        kind: "electronTabLifecycleReady",
        hasBinaryPayload: false,
        coLocatedHostId: "host-1",
        desktopWindowId: "window-1",
      }),
    );
    if (projected.kind !== "frame") throw new Error("expected a frame");
    expect(projected.frame).not.toHaveProperty("desktopWindowId");
    expect(() =>
      browserSessionsClientFrameSchemaV10.parse(projected.frame),
    ).not.toThrow();
  });

  it("refuses attachTab and moveTab, which this line has no spelling for", () => {
    for (const kind of ["attachTab", "moveTab"] as const) {
      const projected = projectBrowserSessionsClientFrameToV10(
        browserSessionsClientFrameSchema.parse({
          kind,
          hasBinaryPayload: false,
          requestId: `${kind}-1`,
          tabId: "browser-tab-1",
        }),
      );
      expect(projected).toEqual({
        kind: "unsupported",
        requestId: `${kind}-1`,
      });
    }
  });

  it("passes an identical-shape client frame through unchanged", () => {
    const frame = browserSessionsClientFrameSchema.parse({
      kind: "closeTab",
      hasBinaryPayload: false,
      requestId: "close-1",
      sessionId: "browser-session-1",
      tabId: "browser-tab-1",
    });
    const projected = projectBrowserSessionsClientFrameToV10(frame);
    if (projected.kind !== "frame") throw new Error("expected a frame");
    expect(() =>
      browserSessionsClientFrameSchemaV10.parse(projected.frame),
    ).not.toThrow();
    expect(projected.frame).toEqual(frame);
  });

  it("exports the refusal reason as a stable, non-empty string", () => {
    expect(BROWSER_SESSIONS_V1_NO_WINDOW_BINDING_REASON.length).toBeGreaterThan(
      0,
    );
  });
});
