import { describe, expect, it } from "vitest";
import { buildProtocolSurface } from "@traycer/protocol/framework/surface-build";
import {
  heldManagedCommandUpdateSchema,
  managedCommandDeliverHeldRequestSchema,
  managedCommandDeliverHeldResponseSchema,
  managedCommandHeldReleaseFailureSchema,
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
});

describe("managedCommand.deliverHeld@1.0 response", () => {
  it("parses an empty Deliver as a legitimate success, not an error", () => {
    const parsed = managedCommandDeliverHeldResponseSchema.parse({
      released: [],
      unresolved: [],
      held: [],
    });
    expect(parsed).toEqual({ released: [], unresolved: [], held: [] });
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
      held: [HELD],
    });
    expect(parsed.released).toEqual(["cmd-released"]);
    expect(parsed.unresolved).toHaveLength(1);
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
