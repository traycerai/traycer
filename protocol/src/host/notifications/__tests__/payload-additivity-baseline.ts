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
} satisfies Record<HostNotificationKnownPayloadKind, JsonSchemaFingerprint>;
