import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  findBreakingChange,
  toJsonSchemaFingerprint,
} from "@traycer/protocol/framework/json-schema-fingerprint";
import {
  hostNotificationAgentStalledPayloadSchema,
  hostNotificationApprovalPayloadSchema,
  hostNotificationChatStoppedPayloadSchema,
  hostNotificationEpicStoppedPayloadSchema,
  hostNotificationInterviewPayloadSchema,
  hostNotificationKnownPayloadSchema,
  hostNotificationWorkspaceOperationFailedPayloadSchema,
  type HostNotificationKnownPayloadKind,
} from "@traycer/protocol/host/notifications/payloads";
import { PAYLOAD_FINGERPRINT_BASELINE } from "./payload-additivity-baseline";

/**
 * Machine-enforces the payload EVOLUTION RULE documented in `payloads.ts`:
 * additive-only, never rename or retype an existing field, new shapes are
 * new kinds. Reuses the versioned-record framework's fingerprint diff
 * engine against the committed baseline, so the convention fails a build
 * instead of a downgrade. See the baseline module for the refresh policy.
 */
const LIVE_PAYLOAD_SCHEMAS: Record<HostNotificationKnownPayloadKind, z.ZodType> =
  {
    chat: hostNotificationChatStoppedPayloadSchema,
    epic: hostNotificationEpicStoppedPayloadSchema,
    agent_stalled: hostNotificationAgentStalledPayloadSchema,
    workspace_operation_failed:
      hostNotificationWorkspaceOperationFailedPayloadSchema,
    approval: hostNotificationApprovalPayloadSchema,
    interview: hostNotificationInterviewPayloadSchema,
  };

const KINDS = [
  "chat",
  "epic",
  "agent_stalled",
  "workspace_operation_failed",
  "approval",
  "interview",
] as const satisfies readonly HostNotificationKnownPayloadKind[];

describe("host notification payload additivity", () => {
  it("baselines every payload kind (a new kind must add its fingerprint to the baseline)", () => {
    const unionKinds = hostNotificationKnownPayloadSchema.options
      .map((option) => option.shape.kind.value)
      .sort();
    expect([...KINDS].sort()).toEqual(unionKinds);
    expect(Object.keys(PAYLOAD_FINGERPRINT_BASELINE).sort()).toEqual(
      unionKinds,
    );
  });

  it.each(KINDS)(
    "payload kind '%s' only evolves additively over the committed baseline",
    (kind) => {
      const current = toJsonSchemaFingerprint(
        LIVE_PAYLOAD_SCHEMAS[kind],
        `host notification payload kind '${kind}'`,
      );
      const breaking = findBreakingChange(
        PAYLOAD_FINGERPRINT_BASELINE[kind],
        current,
      );
      const failure =
        breaking === null
          ? null
          : [
              breaking.reason === "removed"
                ? `FORBIDDEN: ${breaking.kind} '${breaking.detail}' was removed or renamed. ` +
                  `The payload evolution rule is additive-only — restore the field ` +
                  `(a new shape must be a NEW payload kind); never refresh the baseline to silence this.`
                : `${breaking.kind} '${breaking.detail}' changed shape. Renames/retypes are ` +
                  `forbidden; if this is an additive nested change (new optional key, new enum ` +
                  `value), refresh this kind's baseline entry with the fingerprint below so ` +
                  `review sees the diff.`,
              `Current fingerprint for '${kind}':`,
              JSON.stringify(current, null, 2),
            ].join("\n");
      expect(failure).toBeNull();
    },
  );
});
