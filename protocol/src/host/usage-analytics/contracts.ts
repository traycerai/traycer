import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  hostUsageSummaryRequestSchemaV10,
  hostUsageSummaryResponseSchemaV10,
} from "@traycer/protocol/host/usage-analytics/schemas";

/**
 * `host.usage.summary` - the usage analytics read path (see the replication-and-read-path artifact).
 * A host that predates this capability simply lacks the method; the client feature-detects at handshake and hides the usage surface rather than treating the miss as a fatal mismatch.
 */
export const hostUsageSummaryV10 = defineRpcContract({
  method: "host.usage.summary",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostUsageSummaryRequestSchemaV10,
  responseSchema: hostUsageSummaryResponseSchemaV10,
});
