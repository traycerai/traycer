import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  findBreakingChange,
  toUnknownKeyTree,
  toJsonSchemaFingerprint,
} from "@traycer/protocol/framework/json-schema-fingerprint";
import {
  hostNotificationAgentStalledPayloadSchema,
  hostNotificationApprovalPayloadSchema,
  hostNotificationBrowserHumanNeededPayloadSchema,
  hostNotificationChatStoppedPayloadSchema,
  hostNotificationEpicStoppedPayloadSchema,
  hostNotificationInterviewPayloadSchema,
  hostNotificationKnownPayloadSchema,
  hostNotificationManagedCommandDeliveryParkedPayloadSchema,
  hostNotificationSecretExportMintedPayloadSchema,
  hostNotificationSecretGrantRequestPayloadSchema,
  hostNotificationSecretRotatedPayloadSchema,
  hostNotificationTeamInstallingAdminGonePayloadSchema,
  hostNotificationTeamMemberJoinedPayloadSchema,
  hostNotificationTeamMemberRemovedPayloadSchema,
  hostNotificationTeamPlanUnlinkedPayloadSchema,
  hostNotificationTeamPodsFullPayloadSchema,
  hostNotificationEnvironmentMoveStalledPayloadSchema,
  hostNotificationEnvironmentApplyFailedPayloadSchema,
  hostNotificationTeamRoleChangedPayloadSchema,
  hostNotificationTeamHostReturnedPayloadSchema,
  hostNotificationSecretRemovedPayloadSchema,
  hostNotificationSandboxNoticePayloadSchema,
  hostNotificationHooksRemovedPayloadSchema,
  hostNotificationTeamPolicyAuthorityExpiredPayloadSchema,
  hostNotificationTeamPolicyUnappliedPayloadSchema,
  hostNotificationWorkspaceOperationFailedPayloadSchema,
  hostNotificationWorktreeAutoCleanupPayloadSchema,
  hostNotificationWorktreeDeletionPayloadSchema,
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
const LIVE_PAYLOAD_SCHEMAS: Record<
  HostNotificationKnownPayloadKind,
  z.ZodType
> = {
  chat: hostNotificationChatStoppedPayloadSchema,
  epic: hostNotificationEpicStoppedPayloadSchema,
  agent_stalled: hostNotificationAgentStalledPayloadSchema,
  workspace_operation_failed:
    hostNotificationWorkspaceOperationFailedPayloadSchema,
  approval: hostNotificationApprovalPayloadSchema,
  interview: hostNotificationInterviewPayloadSchema,
  worktree_deletion: hostNotificationWorktreeDeletionPayloadSchema,
  worktree_auto_cleanup: hostNotificationWorktreeAutoCleanupPayloadSchema,
  managed_command_delivery_parked:
    hostNotificationManagedCommandDeliveryParkedPayloadSchema,
  browser_human_needed: hostNotificationBrowserHumanNeededPayloadSchema,
  secret_grant_request: hostNotificationSecretGrantRequestPayloadSchema,
  secret_export_minted: hostNotificationSecretExportMintedPayloadSchema,
  secret_rotated: hostNotificationSecretRotatedPayloadSchema,
  team_member_removed: hostNotificationTeamMemberRemovedPayloadSchema,
  team_member_joined: hostNotificationTeamMemberJoinedPayloadSchema,
  team_policy_unapplied: hostNotificationTeamPolicyUnappliedPayloadSchema,
  team_policy_authority_expired:
    hostNotificationTeamPolicyAuthorityExpiredPayloadSchema,
  team_installing_admin_gone:
    hostNotificationTeamInstallingAdminGonePayloadSchema,
  team_plan_unlinked: hostNotificationTeamPlanUnlinkedPayloadSchema,
  team_pods_full: hostNotificationTeamPodsFullPayloadSchema,
  environment_move_stalled: hostNotificationEnvironmentMoveStalledPayloadSchema,
  environment_apply_failed: hostNotificationEnvironmentApplyFailedPayloadSchema,
  team_role_changed: hostNotificationTeamRoleChangedPayloadSchema,
  team_host_returned: hostNotificationTeamHostReturnedPayloadSchema,
  secret_removed: hostNotificationSecretRemovedPayloadSchema,
  sandbox_notice: hostNotificationSandboxNoticePayloadSchema,
  notification_hooks_removed: hostNotificationHooksRemovedPayloadSchema,
};

const KINDS = [
  "chat",
  "epic",
  "agent_stalled",
  "workspace_operation_failed",
  "approval",
  "interview",
  "worktree_deletion",
  "worktree_auto_cleanup",
  "managed_command_delivery_parked",
  "browser_human_needed",
  "secret_grant_request",
  "secret_export_minted",
  "secret_rotated",
  "team_member_removed",
  "team_member_joined",
  "team_policy_unapplied",
  "team_policy_authority_expired",
  "team_installing_admin_gone",
  "team_plan_unlinked",
  "team_pods_full",
  "environment_move_stalled",
  "environment_apply_failed",
  "team_role_changed",
  "team_host_returned",
  "secret_removed",
  "sandbox_notice",
  "notification_hooks_removed",
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
        // The committed baseline is a stored fingerprint with no schema to
        // re-render, so no input tree is available for the previous side;
        // unknown-key policy is not part of what this guard checks.
        null,
        toUnknownKeyTree(LIVE_PAYLOAD_SCHEMAS[kind]),
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
