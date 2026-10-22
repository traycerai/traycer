import { describe, expect, it } from "vitest";
import {
  recordTuiAgentActivityRequestSchema,
  recordTuiAgentActivityRequestSchemaV11,
  recordTuiAgentActivityRequestSchemaV12,
  type RecordTuiAgentActivityRequestV11,
} from "@traycer/protocol/host/agent/tui/unary-schemas";
import { agentTuiRecordActivityUpgradeV11ToV12 } from "@traycer/protocol/host/agent/tui/contracts";

/**
 * Same-major minor projection: when a newer client (canonical @1.1) talks to a
 * host that only speaks @1.0, the transport re-parses the request through the
 * host's older-minor request schema before sending
 * (`prepareRequestPayload` → `olderEntry.contract.requestSchema.safeParse`). A
 * value that survives that parse is sent; one that fails raises a client-side
 * `RPC_ERROR` before anything reaches the host.
 *
 * This pins the two cases the session-id resync work relies on:
 *   • `start`/`stop` (activity hooks) carry the additive `observedHarnessSessionId`
 *     field, which the v1.0 object schema strips - projection SUCCEEDS, so an old
 *     host simply loses the resync and still records the activity edge.
 *   • `resync` (SessionStart hook) is a v1.1-only enum value the v1.0 event enum
 *     cannot represent - projection FAILS, which the SessionStart CLI command
 *     turns into a quiet `host-too-old` no-op instead of hook noise.
 */
function canonical(
  overrides: Partial<RecordTuiAgentActivityRequestV11>,
): RecordTuiAgentActivityRequestV11 {
  return recordTuiAgentActivityRequestSchemaV11.parse({
    epicId: "epic-1",
    tuiAgentId: "agent-1",
    harnessSessionId: null,
    harnessId: "claude",
    event: "start",
    observedHarnessSessionId: "sess-observed-1",
    ...overrides,
  });
}

describe("recordActivity@1.1 → @1.0 request projection", () => {
  it("strips observedHarnessSessionId from a start edge (projection succeeds)", () => {
    const result = recordTuiAgentActivityRequestSchema.safeParse(
      canonical({ event: "start" }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        epicId: "epic-1",
        tuiAgentId: "agent-1",
        harnessSessionId: null,
        harnessId: "claude",
        event: "start",
      });
      expect(result.data).not.toHaveProperty("observedHarnessSessionId");
    }
  });

  it("strips observedHarnessSessionId from a stop edge (projection succeeds)", () => {
    const result = recordTuiAgentActivityRequestSchema.safeParse(
      canonical({ event: "stop" }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.event).toBe("stop");
      expect(result.data).not.toHaveProperty("observedHarnessSessionId");
    }
  });

  it("rejects the resync edge - a v1.0 host cannot represent it (projection fails)", () => {
    const result = recordTuiAgentActivityRequestSchema.safeParse(
      canonical({ event: "resync" }),
    );
    expect(result.success).toBe(false);
  });
});

/**
 * Same projection one minor up: the idle-evidence fields (`spawnToken`,
 * `turnId`, `inFlight`) and the `started` / `idle-confirmed` edges arrive in
 * @1.2. A 1.2 client talking to a 1.1 host strips the fields (projection
 * succeeds); a 1.2-only edge cannot be represented by the 1.1 event enum
 * (projection fails, which the CLI turns into a quiet `host-too-old` no-op).
 */
function canonicalV12(
  overrides: Partial<{
    event: "start" | "stop" | "resync" | "started" | "idle-confirmed";
    spawnToken: string | null;
    turnId: string | null;
    inFlight: { count: number } | null;
  }>,
) {
  return recordTuiAgentActivityRequestSchemaV12.parse({
    epicId: "epic-1",
    tuiAgentId: "agent-1",
    harnessSessionId: null,
    harnessId: "claude",
    event: "stop",
    observedHarnessSessionId: "sess-observed-1",
    spawnToken: "spawn-1",
    turnId: "turn-1",
    inFlight: { count: 2 },
    ...overrides,
  });
}

describe("recordActivity@1.1 → @1.2 upgrade", () => {
  it("fills spawnToken, turnId and inFlight with null", () => {
    const upgraded = agentTuiRecordActivityUpgradeV11ToV12.upgradeRequest(
      canonical({ event: "stop" }),
    );
    expect(upgraded).toEqual({
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      event: "stop",
      observedHarnessSessionId: "sess-observed-1",
      spawnToken: null,
      turnId: null,
      inFlight: null,
    });
  });
});

describe("recordActivity@1.2 → @1.1 request projection", () => {
  it.each(["start", "stop"] as const)(
    "strips spawnToken, turnId and inFlight from a %s edge (projection succeeds)",
    (event) => {
      const result = recordTuiAgentActivityRequestSchemaV11.safeParse(
        canonicalV12({ event }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({
          epicId: "epic-1",
          tuiAgentId: "agent-1",
          harnessSessionId: null,
          harnessId: "claude",
          event,
          observedHarnessSessionId: "sess-observed-1",
        });
        expect(result.data).not.toHaveProperty("spawnToken");
        expect(result.data).not.toHaveProperty("turnId");
        expect(result.data).not.toHaveProperty("inFlight");
      }
    },
  );

  it.each(["started", "idle-confirmed"] as const)(
    "rejects the %s edge - a v1.1 host cannot represent it (projection fails)",
    (event) => {
      const result = recordTuiAgentActivityRequestSchemaV11.safeParse(
        canonicalV12({ event }),
      );
      expect(result.success).toBe(false);
    },
  );
});
