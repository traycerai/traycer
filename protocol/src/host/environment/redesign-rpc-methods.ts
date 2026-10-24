import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  environmentConfigurationGuideGetV10,
  environmentConfigurationGuideResetV10,
  environmentConfigurationGuideSetV10,
  environmentConfigurationItemsDeleteV10,
  environmentConfigurationItemsPutV10,
  environmentConfigurationItemsV10,
  environmentConfigurationMcpServersPutV10,
  environmentConfigurationPolicyPutV10,
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
  environmentMembersInviteV10,
  environmentMembersNoticeSeenV10,
  environmentMembersRemovePreviewV10,
  environmentMembersRemoveV10,
  environmentMembersSetRoleV10,
} from "@traycer/protocol/host/environment/contracts";
import {
  environmentMoveAcceptV10,
  environmentMovePlanV10,
  environmentMoveStopPreviewV10,
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
  "environment.move.plan": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentMovePlanV10,
          upgradeFromPreviousVersion: null,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentMoveStopPreviewV10,
          upgradeFromPreviousVersion: null,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationMcpServersPutV10,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: environmentConfigurationGuideGetV10,
          upgradeFromPreviousVersion: null,
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
