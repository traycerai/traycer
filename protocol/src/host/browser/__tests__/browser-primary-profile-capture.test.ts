import { describe, expect, it } from "vitest";
import {
  browserSessionsClientFrameSchema,
  browserSessionsServerFrameSchema,
  browserStorageStateSchema,
} from "@traycer/protocol/host/browser/contracts";

const CAPTURE_REQUEST = {
  kind: "capturePrimaryProfile",
  hasBinaryPayload: false,
  requestId: "req-capture-1",
} as const;

const CAPTURE_READY = {
  kind: "primaryProfileCaptureReady",
  hasBinaryPayload: false,
  requestId: "req-ready-1",
} as const;

const ELECTRON_LIFECYCLE_READY = {
  kind: "electronTabLifecycleReady",
  hasBinaryPayload: false,
  requestId: "req-electron-ready-1",
} as const;

const CAPTURED_RESPONSE = {
  kind: "primaryProfileCaptured",
  hasBinaryPayload: false,
  requestId: "req-capture-1",
  storageState: {
    cookies: [
      {
        name: "sid",
        value: "abc",
        domain: "example.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins: [
      {
        origin: "https://example.com",
        localStorage: [{ name: "theme", value: "dark" }],
      },
    ],
  },
  status: "captured",
  reason: null,
} as const;

describe("browser.sessions@1.0 primary profile capture frames (ticket 06)", () => {
  it("parses capturePrimaryProfile request frames", () => {
    expect(
      browserSessionsServerFrameSchema.safeParse(CAPTURE_REQUEST).success,
    ).toBe(true);
  });

  it("parses primaryProfileCaptureReady client frames", () => {
    expect(
      browserSessionsClientFrameSchema.safeParse(CAPTURE_READY).success,
    ).toBe(true);
  });

  it("advertises Electron lifecycle readiness independently of profile capture", () => {
    expect(
      browserSessionsClientFrameSchema.safeParse(ELECTRON_LIFECYCLE_READY)
        .success,
    ).toBe(true);
  });

  it("parses primaryProfileCaptured with required status enum", () => {
    expect(
      browserSessionsClientFrameSchema.safeParse(CAPTURED_RESPONSE).success,
    ).toBe(true);
    for (const status of ["unavailable", "failed"] as const) {
      expect(
        browserSessionsClientFrameSchema.safeParse({
          ...CAPTURED_RESPONSE,
          storageState: null,
          status,
          reason: "bridge unavailable",
        }).success,
      ).toBe(true);
    }
  });

  it("validates the semantic storage state independently of its opaque frame", () => {
    expect(
      browserStorageStateSchema.safeParse(CAPTURED_RESPONSE.storageState)
        .success,
    ).toBe(true);
    expect(
      browserStorageStateSchema.safeParse({
        ...CAPTURED_RESPONSE.storageState,
        cookies: [
          { ...CAPTURED_RESPONSE.storageState.cookies[0], sameSite: "Invalid" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects primaryProfileCaptured without status", () => {
    const { status: _status, ...withoutStatus } = CAPTURED_RESPONSE;
    expect(
      browserSessionsClientFrameSchema.safeParse(withoutStatus).success,
    ).toBe(false);
  });

  it("rejects capturePrimaryProfile without requestId", () => {
    const { requestId: _requestId, ...withoutId } = CAPTURE_REQUEST;
    expect(browserSessionsServerFrameSchema.safeParse(withoutId).success).toBe(
      false,
    );
  });

  it("rejects primaryProfileCaptured without storageState field", () => {
    const { storageState: _storageState, ...withoutStorage } =
      CAPTURED_RESPONSE;
    expect(
      browserSessionsClientFrameSchema.safeParse(withoutStorage).success,
    ).toBe(false);
  });

  it("advertises the new frame kinds on the browser.sessions schemas", () => {
    const serverKinds = browserSessionsServerFrameSchema.def.options.map(
      (option): string => String(option.shape.kind.def.values[0]),
    );
    const clientKinds = browserSessionsClientFrameSchema.def.options.map(
      (option): string => String(option.shape.kind.def.values[0]),
    );
    expect(serverKinds).toContain("capturePrimaryProfile");
    expect(clientKinds).toContain("primaryProfileCaptureReady");
    expect(clientKinds).toContain("electronTabLifecycleReady");
    expect(clientKinds).toContain("primaryProfileCaptured");
  });
});
