import { describe, expect, it } from "vitest";
import {
  browserSessionsClientFrameSchema,
  browserSessionsServerFrameSchema,
} from "@traycer/protocol/host/browser/contracts";

const CAPTURE_REQUEST = {
  kind: "capturePrimaryProfile",
  hasBinaryPayload: false,
  requestId: "req-capture-1",
} as const;

const ELECTRON_LIFECYCLE_READY = {
  kind: "electronTabLifecycleReady",
  hasBinaryPayload: false,
  coLocatedHostId: "host-1",
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
        partitionKey: null,
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

  it("advertises the complete Electron lifecycle capability", () => {
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

  it("validates storage state at the capture-frame boundary", () => {
    expect(
      browserSessionsClientFrameSchema.safeParse(CAPTURED_RESPONSE).success,
    ).toBe(true);
    expect(
      browserSessionsClientFrameSchema.safeParse({
        ...CAPTURED_RESPONSE,
        storageState: {
          ...CAPTURED_RESPONSE.storageState,
          cookies: [
            {
              ...CAPTURED_RESPONSE.storageState.cookies[0],
              sameSite: "Invalid",
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("strips Chromium's unmodelled cookie fields instead of rejecting them", () => {
    const parsed = browserSessionsClientFrameSchema.safeParse({
      ...CAPTURED_RESPONSE,
      storageState: {
        ...CAPTURED_RESPONSE.storageState,
        cookies: [
          {
            ...CAPTURED_RESPONSE.storageState.cookies[0],
            _crHasCrossSiteAncestor: false,
          },
        ],
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    if (parsed.data.kind !== "primaryProfileCaptured") {
      throw new Error("expected a primaryProfileCaptured frame");
    }
    expect(parsed.data.storageState?.cookies[0]).toEqual(
      CAPTURED_RESPONSE.storageState.cookies[0],
    );
  });

  it("carries a partitioned cookie's key rather than silently unpartitioning it", () => {
    const parsed = browserSessionsClientFrameSchema.safeParse({
      ...CAPTURED_RESPONSE,
      storageState: {
        ...CAPTURED_RESPONSE.storageState,
        cookies: [
          {
            ...CAPTURED_RESPONSE.storageState.cookies[0],
            partitionKey: "https://example.com",
          },
        ],
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    if (parsed.data.kind !== "primaryProfileCaptured") {
      throw new Error("expected a primaryProfileCaptured frame");
    }
    expect(parsed.data.storageState?.cookies[0]?.partitionKey).toBe(
      "https://example.com",
    );
  });

  it("reads a cookie from a peer built before partitionKey as unpartitioned", () => {
    // A required field here silently dropped every frame a pre-CHIPS peer sent
    // - and every frame this side sent back to one - which read as an inert
    // "+ Add browser" button rather than as a version skew.
    const { partitionKey: _partitionKey, ...withoutPartitionKey } =
      CAPTURED_RESPONSE.storageState.cookies[0];
    const parsed = browserSessionsClientFrameSchema.safeParse({
      ...CAPTURED_RESPONSE,
      storageState: {
        ...CAPTURED_RESPONSE.storageState,
        cookies: [withoutPartitionKey],
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    if (parsed.data.kind !== "primaryProfileCaptured") {
      throw new Error("expected a primaryProfileCaptured frame");
    }
    expect(parsed.data.storageState?.cookies[0]?.partitionKey).toBe(null);
  });

  it("rejects CDP's object partitionKey, which a producer must flatten first", () => {
    // Modelled fields are validated, not stripped: an unflattened
    // `{topLevelSite, hasCrossSiteAncestor}` fails the whole capture rather
    // than quietly dropping the partition. Producers flatten to the string.
    expect(
      browserSessionsClientFrameSchema.safeParse({
        ...CAPTURED_RESPONSE,
        storageState: {
          ...CAPTURED_RESPONSE.storageState,
          cookies: [
            {
              ...CAPTURED_RESPONSE.storageState.cookies[0],
              partitionKey: { topLevelSite: "https://example.com" },
            },
          ],
        },
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
    expect(clientKinds).toContain("electronTabLifecycleReady");
    expect(clientKinds).toContain("primaryProfileCaptured");
  });
});
