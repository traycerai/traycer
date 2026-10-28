import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  environmentConfigurationRevisionV10,
  environmentConfigurationGuideGetUpgradeV10ToV11,
  environmentConfigurationGuideGetV10,
  environmentConfigurationGuideGetV11,
  environmentConfigurationGuideResetV10,
  environmentConfigurationGuideSetV10,
  environmentConfigurationItemsDeleteV10,
  environmentConfigurationItemsPutV10,
  environmentConfigurationItemsV10,
  environmentConfigurationMcpServersDeleteV10,
  environmentConfigurationMcpServersSetEnabledV10,
  environmentConfigurationMcpServersListV10,
  environmentConfigurationMcpServersPutUpgradeV10ToV11,
  environmentConfigurationMcpServersPutV10,
  environmentConfigurationMcpServersPutV11,
  environmentConfigurationPolicyPutV10,
  environmentConfigurationSkillsImportV10,
  environmentConfigurationSkillsListUpgradeV10ToV11,
  environmentConfigurationSkillsListV10,
  environmentConfigurationSkillsListV11,
  environmentConfigurationSkillsRemoveV10,
  environmentConfigurationSkillsRestoreBundledV10,
  environmentConfigurationSkillsSetPolicyV10,
  environmentConfigurationSkillsSetProvidersV10,
  environmentConfigurationSkillsStateV10,
  environmentConfigurationSkillsUpdateV10,
  environmentConfigurationSkillsUploadV10,
  environmentHistoryV10,
  environmentPlansListV10,
  environmentPlansUnlinkPreviewV10,
  environmentPlansUnlinkV10,
} from "@traycer/protocol/host/environment/configuration-contracts";
import {
  environmentReviewHeldApplyRequestSchema,
  environmentReviewHeldApplyResponseSchema,
  environmentReviewRecordRequestSchema,
  environmentReviewRecordResponseSchema,
} from "@traycer/protocol/host/environment-schemas";
import {
  environmentInvitationsAcceptV10,
  environmentInvitationsListV10,
  environmentMembersInviteV10,
  environmentMembersNoticeSeenV10,
  environmentMembersRemovePreviewV10,
  environmentMembersRemoveV10,
  environmentMembersSeatsV10,
  environmentMembersSetRoleV10,
} from "@traycer/protocol/host/environment/contracts";
import {
  environmentMoveAcceptV10,
  environmentMovePlanUpgradeV10ToV11,
  environmentMovePlanUpgradeV11ToV12,
  environmentMovePlanV10,
  environmentMovePlanV11,
  environmentMovePlanV12,
  environmentMoveStopPreviewUpgradeV10ToV11,
  environmentMoveStopPreviewV10,
  environmentMoveStopPreviewV11,
  environmentMoveStopV10,
} from "@traycer/protocol/host/environment/move-contracts";

/**
 * `environment.review.heldApply@1.0`: the retrospective sheet's choice for one
 * held entry. Shapes in `environment-schemas.ts`.
 */
export const environmentReviewHeldApplyV10 = defineRpcContract({
  method: "environment.review.heldApply",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentReviewHeldApplyRequestSchema,
  responseSchema: environmentReviewHeldApplyResponseSchema,
});

/**
 * `environment.review.record@1.0`: the retrospective sheet shown, or
 * acknowledged, on this computer.
 */
export const environmentReviewRecordV10 = defineRpcContract({
  method: "environment.review.record",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentReviewRecordRequestSchema,
  responseSchema: environmentReviewRecordResponseSchema,
});

/**
 * The environments redesign's new methods: the move and stopping sharing
 * (`move-contracts.ts`), a configuration's settings and history through the
 * server pool (`configuration-contracts.ts`), member management
 * (`contracts.ts`) and the retrospective sheet's held-entry choice and record. Each a NEW
 * name at `@1.0`, off `RELEASED_FLOOR_METHOD_NAMES` with
 * `degrade: { kind: "unsupported" }`, so a host that predates one leaves it
 * out of its optional manifest and the GUI meets `E_HOST_UNSUPPORTED`. Its own
 * family, beside `ENVIRONMENT_RPC_METHODS`, to keep each registry literal under
 * TS7056's declaration-emission ceiling.
 */
export const ENVIRONMENT_REDESIGN_RPC_METHODS = {
  "environment.configuration.revision": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationRevisionV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.move.plan": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 2,
      versions: {
        0: {
          contract: environmentMovePlanV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: environmentMovePlanV11,
          upgradeFromPreviousVersion: environmentMovePlanUpgradeV10ToV11,
        },
        2: {
          contract: environmentMovePlanV12,
          upgradeFromPreviousVersion: environmentMovePlanUpgradeV11ToV12,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.move.accept": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentMoveAcceptV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.move.stopPreview": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: environmentMoveStopPreviewV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: environmentMoveStopPreviewV11,
          upgradeFromPreviousVersion: environmentMoveStopPreviewUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.move.stop": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentMoveStopV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.items": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationItemsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.items.put": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationItemsPutV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.items.delete": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationItemsDeleteV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.mcpServers.put": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: environmentConfigurationMcpServersPutV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: environmentConfigurationMcpServersPutV11,
          upgradeFromPreviousVersion:
            environmentConfigurationMcpServersPutUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.mcpServers.list": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationMcpServersListV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.mcpServers.delete": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationMcpServersDeleteV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.mcpServers.setEnabled": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationMcpServersSetEnabledV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.skills.upload": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationSkillsUploadV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.skills.list": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: environmentConfigurationSkillsListV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: environmentConfigurationSkillsListV11,
          upgradeFromPreviousVersion:
            environmentConfigurationSkillsListUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.skills.remove": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationSkillsRemoveV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.skills.setProviders": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationSkillsSetProvidersV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.skills.setPolicy": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationSkillsSetPolicyV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.skills.update": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationSkillsUpdateV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.skills.restoreBundled": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationSkillsRestoreBundledV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.skills.state": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationSkillsStateV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.skills.import": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationSkillsImportV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.policy.put": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationPolicyPutV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.history": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentHistoryV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.members.invite": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentMembersInviteV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.members.setRole": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentMembersSetRoleV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.members.remove": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentMembersRemoveV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.members.removePreview": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentMembersRemovePreviewV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.members.seats": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentMembersSeatsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.invitations.list": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentInvitationsListV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.invitations.accept": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentInvitationsAcceptV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.members.noticeSeen": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentMembersNoticeSeenV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.review.heldApply": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentReviewHeldApplyV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.review.record": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentReviewRecordV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.plans.list": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentPlansListV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.plans.unlinkPreview": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentPlansUnlinkPreviewV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.plans.unlink": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentPlansUnlinkV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.guide.get": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: environmentConfigurationGuideGetV10,
          upgradeFromPreviousVersion: null,
        },
        // `unset` is new: a `@1.0` caller is answered `not_served` instead.
        1: {
          contract: environmentConfigurationGuideGetV11,
          upgradeFromPreviousVersion:
            environmentConfigurationGuideGetUpgradeV10ToV11,
          responseGrowthProjectionGated: true,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.guide.set": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationGuideSetV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.configuration.guide.reset": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationGuideResetV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
} as const;
