import { describe, expect, it } from "vitest";
import { buildProtocolSurface } from "@traycer/protocol/framework/surface-build";
import {
  heldManagedCommandUpdateSchema,
  managedCommandDeliverHeldRequestSchema,
  managedCommandDeliverHeldResponseSchema,
  managedCommandHeldReleaseFailureSchema,
  managedCommandHeldReleaseUnattributedSchema,
} from "@traycer/protocol/host/managed-command/unary-schemas";
import { hostRpcRegistry, hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

/**
 * `managedCommand.deliverHeld@1.0` - the human path off a Stop fence's durable
 * hold. `heldManagedCommandUpdateSchema` is shared with the chat stream, so its
 * behaviour THERE (the snapshot field, the `heldUpdatesChanged` frame, and the
 * frozen `1.6` line's refusal of both) lives in
 * `agent/gui/__tests__/chat-subscribe-held-updates.test.ts`.
 */

const HELD = {
  commandId: "cmd-1",
  description: "deploy watcher",
  heldAtMs: 1_700_000_000_000,
};

describe("managedCommand.deliverHeld@1.0 request", () => {
  it("parses commandIds: null - deliver everything this chat holds", () => {
    const parsed = managedCommandDeliverHeldRequestSchema.parse({
      epicId: "epic-1",
      chatId: "chat-1",
      commandIds: null,
    });
    expect(parsed.commandIds).toBeNull();
  });

  it("parses commandIds narrowed to specific shells", () => {
    const parsed = managedCommandDeliverHeldRequestSchema.parse({
      epicId: "epic-1",
      chatId: "chat-1",
      commandIds: ["a", "b"],
    });
    expect(parsed.commandIds).toEqual(["a", "b"]);
  });

  it("rejects a request missing epicId", () => {
    expect(() =>
      managedCommandDeliverHeldRequestSchema.parse({
        chatId: "chat-1",
        commandIds: null,
      }),
    ).toThrow();
  });

  it("rejects a request missing chatId", () => {
    expect(() =>
      managedCommandDeliverHeldRequestSchema.parse({
        epicId: "epic-1",
        commandIds: null,
      }),
    ).toThrow();
  });

  // An empty array used to parse as "deliver nothing" and resolve as an
  // empty, fully-successful response - indistinguishable on the wire from a
  // real delivery. Nothing a person can do produces it; it is what a caller
  // that meant `null` gets from building the array off an empty selection.
  it("rejects an empty commandIds array rather than accepting it as \"deliver nothing\"", () => {
    expect(() =>
      managedCommandDeliverHeldRequestSchema.parse({
        epicId: "epic-1",
        chatId: "chat-1",
        commandIds: [],
      }),
    ).toThrow();
  });

  it("accepts a single-element commandIds array", () => {
    const parsed = managedCommandDeliverHeldRequestSchema.parse({
      epicId: "epic-1",
      chatId: "chat-1",
      commandIds: ["a"],
    });
    expect(parsed.commandIds).toEqual(["a"]);
  });
});

describe("managedCommand.deliverHeld@1.0 response", () => {
  it("parses an empty Deliver as a legitimate success, not an error", () => {
    const parsed = managedCommandDeliverHeldResponseSchema.parse({
      released: [],
      unresolved: [],
      unattributed: [],
      held: [],
    });
    expect(parsed).toEqual({
      released: [],
      unresolved: [],
      unattributed: [],
      held: [],
    });
  });

  it("parses partial success - one released and one unresolved together", () => {
    const parsed = managedCommandDeliverHeldResponseSchema.parse({
      released: ["cmd-released"],
      unresolved: [
        {
          commandId: "cmd-stuck",
          code: "delivery_row_decode_failed",
          retryable: false,
          message: "written by a newer host build",
        },
      ],
      unattributed: [],
      held: [HELD],
    });
    expect(parsed.released).toEqual(["cmd-released"]);
    expect(parsed.unresolved).toHaveLength(1);
    expect(parsed.unattributed).toEqual([]);
    expect(parsed.held).toEqual([HELD]);
  });

  it("requires retryable as a boolean", () => {
    expect(() =>
      managedCommandHeldReleaseFailureSchema.parse({
        commandId: "cmd-1",
        code: "boot_record_load_failed",
        message: "no retryable flag",
      }),
    ).toThrow();
  });

  // `commandId` is required on the per-command failure - a failure the host
  // cannot attribute to one command belongs in `unattributed` instead, so
  // that `unresolved.length` is always a count of shells.
  it("requires commandId on a per-command failure - no longer nullable", () => {
    expect(() =>
      managedCommandHeldReleaseFailureSchema.parse({
        commandId: null,
        code: "still_held",
        retryable: true,
        message: "held under a newer Stop",
      }),
    ).toThrow();
  });

  // `code` is deliberately free-form, NOT an enum, so a failure mode the
  // schema has never seen still parses - the wire never breaks when the host
  // learns a new one.
  it("parses a code the schema has never seen", () => {
    const parsed = managedCommandHeldReleaseFailureSchema.parse({
      commandId: "cmd-1",
      code: "some_future_failure_mode_never_enumerated_here",
      retryable: true,
      message: "a reason nobody wrote down yet",
    });
    expect(parsed.code).toBe("some_future_failure_mode_never_enumerated_here");
  });
});

describe("managedCommand.deliverHeld@1.0 response - unattributed failures", () => {
  // The proof arms that fail before anything is enumerated (a disposed
  // router, an unreadable delivery-state table, a failed boot record load)
  // have no command to name - this is where THAT goes, distinct from
  // `unresolved`, so a chat holding four commands does not get reported as
  // "1 shell can't be delivered".
  it("carries no commandId - only code, retryable, message", () => {
    const parsed = managedCommandHeldReleaseUnattributedSchema.parse({
      code: "command_records_unavailable",
      retryable: false,
      message: "the host's command records failed to load",
    });
    expect(parsed).toEqual({
      code: "command_records_unavailable",
      retryable: false,
      message: "the host's command records failed to load",
    });
    expect(Object.hasOwn(parsed, "commandId")).toBe(false);
  });

  it("rejects a commandId field on the unattributed shape", () => {
    // Zod's default (non-strict) object parsing drops unknown keys rather
    // than rejecting them, so this only proves the field does not survive a
    // parse - not that providing it throws. That is the property this test
    // actually needs: a caller cannot smuggle a commandId through this shape.
    const parsed = managedCommandHeldReleaseUnattributedSchema.parse({
      commandId: "should-not-survive",
      code: "delivery_state_unreadable",
      retryable: true,
      message: "the delivery-state table could not be read",
    });
    expect(Object.hasOwn(parsed, "commandId")).toBe(false);
  });

  it("parses a response whose unattributed failure disarms the rest, all empty", () => {
    const parsed = managedCommandDeliverHeldResponseSchema.parse({
      released: [],
      unresolved: [],
      unattributed: [
        {
          code: "router_disposed",
          retryable: false,
          message: "the delivery router was disposed",
        },
      ],
      held: [],
    });
    expect(parsed.unattributed).toHaveLength(1);
    expect(parsed.released).toEqual([]);
    expect(parsed.held).toEqual([]);
  });
});

describe("heldManagedCommandUpdate", () => {
  it("carries the hold's identity, label, and install time", () => {
    const parsed = heldManagedCommandUpdateSchema.parse(HELD);
    expect(parsed).toEqual(HELD);
  });
});

describe("managedCommand.deliverHeld registry membership", () => {
  it("is registered at 1.0 with the same degrade as its start/stop/delete siblings", () => {
    const line = hostRpcRegistry["managedCommand.deliverHeld"];
    expect(line[1].latestMinor).toBe(0);
    expect(line[1].versions[0].contract.method).toBe(
      "managedCommand.deliverHeld",
    );
    expect(line.degrade).toEqual({ kind: "unsupported" });
  });

  it("stays off the released floor, like its siblings", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(
      "managedCommand.deliverHeld",
    );
  });

  // An entry in `unary` (the floor channel) would be a FATAL handshake break
  // for every already-released peer, which never negotiated this method.
  it("lands in optionalUnary, never in unary", () => {
    const surface = buildProtocolSurface({
      unary: hostRpcRegistry,
      unaryFloorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
      stream: hostStreamRpcRegistry,
    });
    expect(surface.optionalUnary).toHaveProperty("managedCommand.deliverHeld");
    expect(surface.unary).not.toHaveProperty("managedCommand.deliverHeld");
    expect(surface.optionalUnary["managedCommand.deliverHeld"].degrade).toEqual(
      { kind: "unsupported" },
    );
  });
});
