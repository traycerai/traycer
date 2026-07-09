import { describe, expect, it } from "vitest";
import {
  recordTuiAgentActivityRequestSchema,
  recordTuiAgentActivityRequestSchemaV11,
  type RecordTuiAgentActivityRequestV11,
} from "@traycer/protocol/host/agent/tui/unary-schemas";

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
