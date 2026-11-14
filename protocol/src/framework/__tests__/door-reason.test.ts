import { describe, expect, it } from "vitest";
import {
  HOST_DOOR_REASONS,
  readDoorReason,
} from "@traycer/protocol/framework/door-reason";
import { hostStreamFatalErrorFrameSchema } from "@traycer/protocol/framework/stream-ws-protocol";
import {
  fatalErrorDetailsSchema,
  hostFatalErrorFrameSchema,
  hostFrameSchema,
  hostResponseErrorSchema,
  hostResponseFrameSchema,
} from "@traycer/protocol/framework/ws-protocol";
import {
  fatalPayloadSchema,
  sessionOpenPayloadSchema,
} from "@traycer/protocol/host-transport/mux";

/**
 * `doorReason` on the fatal-error payload (`/rpc`, `/stream`, relay `FATAL`)
 * and on a persistent `/rpc` response error, plus `namedUserId` on a session
 * OPEN's `authz`. An empty string fails the parse. A missing key stays
 * missing. An older copy of a door-reason carrier strips `doorReason`.
 */

const FATAL_DETAILS = {
  code: "FORBIDDEN",
  reason: "refused at the door",
  incompatibleMethods: null,
  upgradeGuidance: null,
};

const KNOWN_REASON = "not_admitted";

const RESPONSE_ERROR = {
  code: "FORBIDDEN",
  message: "refused at the door",
};

function fatalErrorFrame(doorReason: string | undefined) {
  return {
    kind: "fatalError" as const,
    details:
      doorReason === undefined
        ? FATAL_DETAILS
        : { ...FATAL_DETAILS, doorReason },
  };
}

function responseFrame(doorReason: string | undefined) {
  return {
    kind: "response" as const,
    requestId: "req-1",
    method: "host.status",
    schemaVersion: { major: 1, minor: 0 },
    result: null,
    error:
      doorReason === undefined
        ? RESPONSE_ERROR
        : { ...RESPONSE_ERROR, doorReason },
  };
}

function relayFatal(doorReason: string) {
  return { details: { ...FATAL_DETAILS, doorReason } };
}

function rpcFatalDoorReason(doorReason: string): string | undefined {
  const parsed = hostFrameSchema.safeParse(fatalErrorFrame(doorReason));
  expect(parsed.success).toBe(true);
  if (!parsed.success || parsed.data.kind !== "fatalError") {
    throw new Error("hostFrameSchema did not parse a fatalError frame");
  }
  return parsed.data.details.doorReason;
}

function streamFatalDoorReason(doorReason: string): string | undefined {
  const parsed = hostStreamFatalErrorFrameSchema.safeParse(
    fatalErrorFrame(doorReason),
  );
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error("hostStreamFatalErrorFrameSchema rejected the frame");
  }
  return parsed.data.details.doorReason;
}

function relayFatalDoorReason(doorReason: string): string | undefined {
  const parsed = fatalPayloadSchema.safeParse(relayFatal(doorReason));
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error("fatalPayloadSchema rejected the payload");
  }
  return parsed.data.details.doorReason;
}

function responseErrorDoorReason(doorReason: string): string | undefined {
  const parsed = hostFrameSchema.safeParse(responseFrame(doorReason));
  expect(parsed.success).toBe(true);
  if (
    !parsed.success ||
    parsed.data.kind !== "response" ||
    parsed.data.error === null
  ) {
    throw new Error("hostFrameSchema did not parse a response error");
  }
  return parsed.data.error.doorReason;
}

describe("doorReason", () => {
  it.each([
    {
      name: "a /stream fatalError frame keeps doorReason",
      read: streamFatalDoorReason,
    },
    {
      name: "a relay FATAL payload keeps doorReason",
      read: relayFatalDoorReason,
    },
    {
      name: "an /rpc response error keeps doorReason",
      read: responseErrorDoorReason,
    },
  ])("$name", ({ read }) => {
    expect(read(KNOWN_REASON)).toBe(KNOWN_REASON);
  });

  it.each(HOST_DOOR_REASONS)(
    "readDoorReason narrows %s from an /rpc fatalError frame",
    (reason) => {
      expect(readDoorReason(rpcFatalDoorReason(reason))).toBe(reason);
    },
  );

  it("reads an unknown doorReason on a relay FATAL payload as unrecognised", () => {
    expect(readDoorReason(relayFatalDoorReason("some_future_reason"))).toBe(
      "unrecognised",
    );
  });

  it("leaves a missing doorReason absent on a /stream fatalError frame", () => {
    const parsed = hostStreamFatalErrorFrameSchema.safeParse(
      fatalErrorFrame(undefined),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.details).not.toHaveProperty("doorReason");
      expect(readDoorReason(parsed.data.details.doorReason)).toBe("absent");
    }
  });

  it("rejects an empty doorReason on the relay FATAL payload", () => {
    expect(fatalPayloadSchema.safeParse(relayFatal("")).success).toBe(false);
  });

  it("rejects an empty doorReason on an /rpc response error", () => {
    expect(hostFrameSchema.safeParse(responseFrame("")).success).toBe(false);
  });

  it("strips doorReason when an older fatalError frame schema parses it", () => {
    const olderFatalFrameSchema = hostFatalErrorFrameSchema.extend({
      details: fatalErrorDetailsSchema.omit({ doorReason: true }),
    });
    const parsed = olderFatalFrameSchema.parse(fatalErrorFrame(KNOWN_REASON));
    expect(parsed.details).toEqual(FATAL_DETAILS);
  });

  it("strips doorReason when an older response frame schema parses it", () => {
    const olderResponseFrameSchema = hostResponseFrameSchema.extend({
      error: hostResponseErrorSchema.omit({ doorReason: true }).nullable(),
    });
    const parsed = olderResponseFrameSchema.parse(responseFrame(KNOWN_REASON));
    expect(parsed.error).toMatchObject(RESPONSE_ERROR);
    expect(parsed.error).not.toHaveProperty("doorReason");
  });
});

// The session OPEN shape `client-identity.test.ts` already parses.
// `mux-payloads.test.ts` has no OPEN fixture, and that one is not exported.
const sessionOpenBase = {
  muxVersion: 1,
  bearer: "b",
  manifest: {
    rpc: { "host.status": { major: 1, minor: 0 } },
    optionalRpc: {},
    stream: {},
  },
  resume: null,
};

describe("session OPEN authz.namedUserId", () => {
  it("keeps namedUserId on a session OPEN", () => {
    const parsed = sessionOpenPayloadSchema.safeParse({
      ...sessionOpenBase,
      authz: { v: 1, grant: "grant-1", namedUserId: "user-1" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.authz).toEqual({
        v: 1,
        grant: "grant-1",
        namedUserId: "user-1",
      });
    }
  });

  it("leaves namedUserId absent when a session OPEN omits it", () => {
    const parsed = sessionOpenPayloadSchema.safeParse({
      ...sessionOpenBase,
      authz: { v: 1, grant: "grant-1" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.authz).toEqual({ v: 1, grant: "grant-1" });
      expect(parsed.data.authz).not.toHaveProperty("namedUserId");
    }
  });

  it("refuses a session OPEN with an empty namedUserId", () => {
    expect(
      sessionOpenPayloadSchema.safeParse({
        ...sessionOpenBase,
        authz: { v: 1, grant: "grant-1", namedUserId: "" },
      }).success,
    ).toBe(false);
  });
});
