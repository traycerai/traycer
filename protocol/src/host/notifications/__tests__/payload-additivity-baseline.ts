import type { JsonSchemaFingerprint } from "@traycer/protocol/framework/json-schema-fingerprint";
import type { HostNotificationKnownPayloadKind } from "@traycer/protocol/host/notifications/payloads";

/**
 * Committed structural baseline for the Lane-B payload evolution rule in
 * `payloads.ts` ("additive-only: never rename or retype an existing field;
 * a new shape is a NEW payload kind"). `payload-additivity.test.ts` diffs
 * the live schemas against this file with the framework's fingerprint
 * engine, turning the doc-comment convention into a machine-enforced check.
 *
 * When the test fails:
 *  - a `removed` finding means a field/enum-value was dropped or renamed —
 *    that is forbidden; fix the schema, never this file;
 *  - a `schema-changed` finding on a field you extended additively (e.g. a
 *    new optional key inside a nested object) is the one legitimate reason
 *    to refresh that entry — paste the current fingerprint printed in the
 *    failure output, and let review see the diff;
 *  - a new payload kind must add its fingerprint here (the coverage test
 *    prints it).
 */
export const PAYLOAD_FINGERPRINT_BASELINE = {
  chat: {
    type: "object",
    properties: {
      kind: { type: "string", const: "chat" },
      epicId: { type: "string", minLength: 1 },
      chatId: {
        anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
      },
      agentName: { type: "string" },
      taskTitle: { type: "string" },
      outcome: { type: "string", enum: ["completed", "stopped", "errored"] },
      code: { type: "string" },
      message: { type: "string" },
      reason: { type: "string" },
      providerId: { type: "string" },
    },
    required: ["kind", "epicId", "chatId", "agentName", "taskTitle", "outcome"],
  },
  epic: {
    type: "object",
    properties: {
      kind: { type: "string", const: "epic" },
      epicId: { type: "string", minLength: 1 },
      tuiAgentId: { type: "string", minLength: 1 },
      agentName: { type: "string" },
      taskTitle: { type: "string" },
      outcome: { type: "string", enum: ["completed", "stopped", "errored"] },
      code: { type: "string" },
      message: { type: "string" },
      reason: { type: "string" },
      providerId: { type: "string" },
    },
    required: [
      "kind",
      "epicId",
      "tuiAgentId",
      "agentName",
      "taskTitle",
      "outcome",
    ],
  },
  agent_stalled: {
    type: "object",
    properties: {
      kind: { type: "string", const: "agent_stalled" },
      epicId: { type: "string", minLength: 1 },
      chatId: { type: "string", minLength: 1 },
      agentId: { type: "string", minLength: 1 },
      agentName: { type: "string" },
      taskTitle: { type: "string" },
      reason: { type: "string" },
      title: { type: "string" },
      message: { type: "string" },
      outcome: { type: "string", enum: ["completed", "stopped", "errored"] },
    },
    required: [
      "kind",
      "epicId",
      "chatId",
      "agentId",
      "agentName",
      "taskTitle",
      "reason",
      "title",
      "outcome",
    ],
  },
  workspace_operation_failed: {
    type: "object",
    properties: {
      kind: { type: "string", const: "workspace_operation_failed" },
      epicId: { type: "string", minLength: 1 },
      chatId: { type: "string", minLength: 1 },
      chatTitle: { type: "string" },
      taskTitle: { type: "string" },
      operation: { type: "string", minLength: 1 },
      title: { type: "string" },
      message: { type: "string" },
      workspacePath: { type: "string" },
      worktreePath: { type: "string" },
      branch: { type: "string" },
      setupExitCode: {
        anyOf: [
          {
            type: "integer",
            minimum: -9007199254740991,
            maximum: 9007199254740991,
          },
          { type: "null" },
        ],
      },
      terminalSessionId: { type: "string" },
      outcome: { type: "string", const: "errored" },
    },
    required: [
      "kind",
      "epicId",
      "chatId",
      "chatTitle",
      "taskTitle",
      "operation",
      "title",
      "message",
      "outcome",
    ],
  },
  approval: {
    type: "object",
    properties: {
      kind: { type: "string", const: "approval" },
      epicId: { type: "string", minLength: 1 },
      chatId: { type: "string", minLength: 1 },
      chatTitle: { type: "string" },
      taskTitle: { type: "string" },
      approvalId: { type: "string", minLength: 1 },
    },
    required: [
      "kind",
      "epicId",
      "chatId",
      "chatTitle",
      "taskTitle",
      "approvalId",
    ],
  },
  interview: {
    type: "object",
    properties: {
      kind: { type: "string", const: "interview" },
      epicId: { type: "string", minLength: 1 },
      chatId: { type: "string", minLength: 1 },
      chatTitle: { type: "string" },
      taskTitle: { type: "string" },
      interviewBlockId: { type: "string", minLength: 1 },
    },
    required: [
      "kind",
      "epicId",
      "chatId",
      "chatTitle",
      "taskTitle",
      "interviewBlockId",
    ],
  },
  browser_human_needed: {
    type: "object",
    properties: {
      kind: { type: "string", const: "browser_human_needed" },
      epicId: { type: "string", minLength: 1 },
      chatId: { type: "string", minLength: 1 },
      sessionId: { type: "string", minLength: 1 },
      tabId: { type: "string", minLength: 1 },
      reason: { type: "string", minLength: 1 },
    },
    required: ["kind", "epicId", "chatId", "sessionId", "tabId", "reason"],
  },
  worktree_deletion: {
    type: "object",
    properties: {
      kind: { type: "string", const: "worktree_deletion" },
      operation: { type: "string", const: "worktree.deletion" },
      title: { type: "string", minLength: 1 },
      message: { type: "string", minLength: 1 },
      commandId: { type: "string", minLength: 1 },
      source: { type: "string", minLength: 1 },
      requestedCount: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
      deletedCount: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
      failedCount: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
    },
    required: [
      "kind",
      "operation",
      "title",
      "message",
      "commandId",
      "source",
      "requestedCount",
      "deletedCount",
      "failedCount",
    ],
  },
  worktree_auto_cleanup: {
    type: "object",
    properties: {
      kind: { type: "string", const: "worktree_auto_cleanup" },
      operation: { type: "string", const: "worktree.autoCleanup" },
      title: { type: "string", minLength: 1 },
      message: { type: "string", minLength: 1 },
      runId: { type: "string", minLength: 1 },
      hostId: { type: "string", minLength: 1 },
      deletedCount: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
      skippedCount: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
      failedCount: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
      interruptedCount: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
    },
    required: [
      "kind",
      "operation",
      "title",
      "message",
      "runId",
      "hostId",
      "deletedCount",
      "skippedCount",
      "failedCount",
      "interruptedCount",
    ],
  },
  managed_command_delivery_parked: {
    type: "object",
    properties: {
      kind: { type: "string", const: "managed_command_delivery_parked" },
      operation: { type: "string", const: "managed-command.delivery" },
      title: { type: "string", minLength: 1 },
      message: { type: "string", minLength: 1 },
      commandId: { type: "string", minLength: 1 },
      epicId: { type: "string", minLength: 1 },
      chatId: { type: "string", minLength: 1 },
    },
    required: [
      "kind",
      "operation",
      "title",
      "message",
      "commandId",
      "epicId",
      "chatId",
    ],
  },
  secret_grant_request: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        const: "secret_grant_request",
      },
      requestId: {
        type: "string",
        minLength: 1,
      },
      hostId: {
        type: "string",
        minLength: 1,
      },
      secretName: {
        anyOf: [
          {
            type: "string",
            minLength: 1,
          },
          {
            type: "null",
          },
        ],
      },
      destination: {
        anyOf: [
          {
            type: "string",
            minLength: 1,
          },
          {
            type: "null",
          },
        ],
      },
      port: {
        anyOf: [
          {
            type: "integer",
            exclusiveMinimum: 0,
            maximum: 9007199254740991,
          },
          {
            type: "null",
          },
        ],
      },
      protocol: {
        anyOf: [
          {
            type: "string",
            minLength: 1,
          },
          {
            type: "null",
          },
        ],
      },
      reason: {
        type: "string",
      },
      sandboxName: {
        type: "string",
      },
      agentId: {
        anyOf: [
          {
            type: "string",
            minLength: 1,
          },
          {
            type: "null",
          },
        ],
      },
      epicId: {
        type: "string",
        minLength: 1,
      },
      chatId: {
        type: "string",
        minLength: 1,
      },
    },
    required: [
      "kind",
      "requestId",
      "hostId",
      "secretName",
      "destination",
      "protocol",
      "reason",
    ],
  },
  secret_export_minted: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        const: "secret_export_minted",
      },
      secretName: {
        type: "string",
        minLength: 1,
      },
      exportKind: {
        type: "string",
        minLength: 1,
      },
      expiresAt: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
      hostId: {
        type: "string",
        minLength: 1,
      },
      agentId: {
        anyOf: [
          {
            type: "string",
            minLength: 1,
          },
          {
            type: "null",
          },
        ],
      },
      epicId: {
        type: "string",
        minLength: 1,
      },
      chatId: {
        type: "string",
        minLength: 1,
      },
    },
    required: ["kind", "secretName", "exportKind", "expiresAt", "hostId"],
  },
  secret_rotated: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        const: "secret_rotated",
      },
      secretName: {
        type: "string",
        minLength: 1,
      },
      secretId: {
        anyOf: [
          {
            type: "string",
            minLength: 1,
          },
          {
            type: "null",
          },
        ],
      },
      environmentId: {
        type: "string",
        minLength: 1,
      },
      rotationId: {
        type: "string",
        minLength: 1,
      },
      state: {
        type: "string",
        minLength: 1,
      },
      evidence: {
        type: "array",
        items: {
          type: "object",
          properties: {
            producer: {
              type: "string",
              minLength: 1,
            },
            workerClass: {
              anyOf: [
                {
                  type: "string",
                  minLength: 1,
                },
                {
                  type: "null",
                },
              ],
            },
            hostId: {
              anyOf: [
                {
                  type: "string",
                  minLength: 1,
                },
                {
                  type: "null",
                },
              ],
            },
            hostName: {
              anyOf: [
                {
                  type: "string",
                },
                {
                  type: "null",
                },
              ],
            },
            status: {
              type: "string",
              minLength: 1,
            },
            evidence: {
              anyOf: [
                {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      kind: {
                        type: "string",
                        minLength: 1,
                      },
                      count: {
                        anyOf: [
                          {
                            type: "integer",
                            minimum: 0,
                            maximum: 9007199254740991,
                          },
                          {
                            type: "null",
                          },
                        ],
                      },
                    },
                    required: ["kind", "count"],
                    additionalProperties: {},
                  },
                },
                {
                  type: "null",
                },
              ],
            },
          },
          required: [
            "producer",
            "workerClass",
            "hostId",
            "hostName",
            "status",
            "evidence",
          ],
          additionalProperties: {},
        },
      },
    },
    required: [
      "kind",
      "secretName",
      "secretId",
      "environmentId",
      "rotationId",
      "state",
      "evidence",
    ],
  },
  team_member_removed: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        const: "team_member_removed",
      },
      environmentId: {
        type: "string",
        minLength: 1,
      },
      teamName: {
        type: "string",
      },
      memberName: {
        type: "string",
      },
      hosts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            hostId: {
              type: "string",
              minLength: 1,
            },
            hostName: {
              type: "string",
            },
            stopped: {
              type: "string",
              minLength: 1,
            },
            credentialClosed: {
              type: "string",
              minLength: 1,
            },
            replacementDelivered: {
              type: "string",
              minLength: 1,
            },
          },
          required: [
            "hostId",
            "hostName",
            "stopped",
            "credentialClosed",
            "replacementDelivered",
          ],
          additionalProperties: {},
        },
      },
    },
    required: ["kind", "environmentId", "teamName", "memberName", "hosts"],
  },
  team_member_joined: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        const: "team_member_joined",
      },
      environmentId: {
        type: "string",
        minLength: 1,
      },
      teamName: {
        type: "string",
      },
      memberName: {
        type: "string",
      },
      toNewcomer: {
        type: "boolean",
      },
    },
    required: ["kind", "environmentId", "teamName", "memberName", "toNewcomer"],
  },
  team_policy_unapplied: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        const: "team_policy_unapplied",
      },
      environmentId: {
        type: "string",
        minLength: 1,
      },
      teamName: {
        type: "string",
      },
      policyVersion: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
    },
    required: ["kind", "environmentId", "teamName", "policyVersion"],
  },
  team_policy_authority_expired: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        const: "team_policy_authority_expired",
      },
      environmentId: {
        type: "string",
        minLength: 1,
      },
      teamName: {
        type: "string",
      },
      hostId: {
        type: "string",
        minLength: 1,
      },
      hostName: {
        type: "string",
      },
    },
    required: ["kind", "environmentId", "teamName", "hostId", "hostName"],
  },
  team_installing_admin_gone: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        const: "team_installing_admin_gone",
      },
      environmentId: {
        type: "string",
        minLength: 1,
      },
      teamName: {
        type: "string",
      },
      adminName: {
        type: "string",
      },
      reason: {
        type: "string",
        minLength: 1,
      },
    },
    required: ["kind", "environmentId", "teamName", "adminName", "reason"],
  },
  team_plan_unlinked: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        const: "team_plan_unlinked",
      },
      environmentId: {
        type: "string",
        minLength: 1,
      },
      teamName: {
        type: "string",
      },
    },
    required: ["kind", "environmentId", "teamName"],
  },
  team_pods_full: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        const: "team_pods_full",
      },
      environmentId: {
        type: "string",
        minLength: 1,
      },
      teamName: {
        type: "string",
      },
      podCount: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
    },
    required: ["kind", "environmentId", "teamName", "podCount"],
  },
  environment_move_stalled: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        const: "environment_move_stalled",
      },
      environmentId: {
        type: "string",
        minLength: 1,
      },
      hostId: {
        type: "string",
        minLength: 1,
      },
      hostName: {
        type: "string",
      },
      remaining: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
      reason: {
        type: "string",
        minLength: 1,
      },
    },
    required: [
      "kind",
      "environmentId",
      "hostId",
      "hostName",
      "remaining",
      "reason",
    ],
  },
  environment_apply_failed: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        const: "environment_apply_failed",
      },
      environmentId: {
        type: "string",
        minLength: 1,
      },
      hostId: {
        type: "string",
        minLength: 1,
      },
      hostName: {
        type: "string",
      },
      itemKey: {
        type: "string",
        minLength: 1,
      },
      reason: {
        type: "string",
        minLength: 1,
      },
    },
    required: [
      "kind",
      "environmentId",
      "hostId",
      "hostName",
      "itemKey",
      "reason",
    ],
  },
  team_role_changed: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        const: "team_role_changed",
      },
      environmentId: {
        type: "string",
        minLength: 1,
      },
      teamName: {
        type: "string",
      },
      from: {
        type: "string",
        minLength: 1,
      },
      to: {
        type: "string",
        minLength: 1,
      },
    },
    required: ["kind", "environmentId", "teamName", "from", "to"],
  },
  team_host_returned: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        const: "team_host_returned",
      },
      environmentId: {
        type: "string",
        minLength: 1,
      },
      teamName: {
        type: "string",
      },
      hostName: {
        type: "string",
      },
    },
    required: ["kind", "environmentId", "teamName", "hostName"],
  },
  secret_removed: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        const: "secret_removed",
      },
      environmentId: {
        type: "string",
        minLength: 1,
      },
      secretName: {
        type: "string",
      },
      outcome: {
        type: "string",
        enum: ["revoked", "cleanup_requested", "destroyed"],
      },
    },
    required: ["kind", "environmentId", "secretName", "outcome"],
  },
  sandbox_notice: {
    type: "object",
    properties: {
      kind: { type: "string", const: "sandbox_notice" },
      sandboxId: { type: "string", minLength: 1 },
      sandboxName: { type: "string" },
      notice: {
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", const: "resting_warning" },
              destroyAt: {
                type: "integer",
                minimum: 0,
                maximum: 9007199254740991,
              },
              periodMinutes: {
                type: "integer",
                exclusiveMinimum: 0,
                maximum: 9007199254740991,
              },
            },
            required: ["kind", "destroyAt", "periodMinutes"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", const: "resting_destroyed" },
            },
            required: ["kind"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", const: "frozen" },
              cause: { type: "string", enum: ["credits", "payer_removed"] },
            },
            required: ["kind", "cause"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", const: "frozen_warning" },
              daysLeft: {
                type: "integer",
                exclusiveMinimum: 0,
                maximum: 9007199254740991,
              },
            },
            required: ["kind", "daysLeft"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { kind: { type: "string", const: "frozen_deleting" } },
            required: ["kind"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { kind: { type: "string", const: "frozen_destroyed" } },
            required: ["kind"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { kind: { type: "string", const: "create_failed" } },
            required: ["kind"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { kind: { type: "string", const: "lost" } },
            required: ["kind"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", const: "destroyed_by_member" },
              actorName: { anyOf: [{ type: "string" }, { type: "null" }] },
              destroyedAt: {
                type: "integer",
                minimum: 0,
                maximum: 9007199254740991,
              },
              stoppedAgentTaskTitles: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["kind", "actorName"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", const: "manual_rest" },
              verb: { type: "string", enum: ["suspend", "stop"] },
              outcome: { type: "string", enum: ["confirmed", "failed"] },
              byYou: { type: "boolean" },
              actorName: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
            required: ["kind", "verb", "outcome", "byYou", "actorName"],
            additionalProperties: false,
          },
        ],
        "x-traycer-discriminator": "kind",
      },
    },
    required: ["kind", "sandboxId", "sandboxName", "notice"],
  },
} satisfies Record<HostNotificationKnownPayloadKind, JsonSchemaFingerprint>;
