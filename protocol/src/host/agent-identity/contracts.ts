/**
 * Versioned contracts for the unary half of `agentIdentity.*`.
 *
 * Every one opens at `{ major: 1, minor: 0 }` with no upgrade or downgrade path,
 * because there is nothing to bridge FROM: a method name that has never shipped
 * has no released baseline, so it needs no frozen copy and no
 * `downgradePathsFromLatest` entry - only the `degrade: { kind: "unsupported" }`
 * the registry requires of every non-floor method. See
 * `agent-identity/schemas.ts` for what an old peer does instead.
 *
 * The Hermes importer (`import.hermes.*`) has schemas in `unary-schemas.ts`
 * but NO contract here yet: T12 adds the contract, the registry entry and the
 * gui-app policy row together with its host resolvers. The host's
 * resolver-coverage gate fails any advertised method without a resolver, so a
 * contract registered ahead of its resolver would be a red host build rather
 * than an early start.
 *
 * The two STREAM contracts live beside their frame schemas
 * (`state-subscribe.ts`, `file-subscribe.ts`) rather than here, following
 * `epic/state-subscribe.ts` and `epic/artifact-subscribe.ts`: a stream contract
 * is three schemas and one line, and splitting it from the frames it names would
 * put the line furthest from the thing most likely to change with it.
 */
import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  agentIdentityCreateRequestSchema,
  agentIdentityCreateResponseSchema,
  agentIdentityDeleteRequestSchema,
  agentIdentityDeleteResponseSchema,
  agentIdentityFilesAddRequestSchema,
  agentIdentityFilesAddResponseSchema,
  agentIdentityFilesDeleteRequestSchema,
  agentIdentityFilesDeleteResponseSchema,
  agentIdentityFilesRenameRequestSchema,
  agentIdentityFilesRenameResponseSchema,
  agentIdentityFilesReadBlobRequestSchema,
  agentIdentityFilesReadBlobResponseSchema,
  agentIdentityFilesUploadBlobRequestSchema,
  agentIdentityFilesUploadBlobResponseSchema,
  agentIdentityHistoryListRequestSchema,
  agentIdentityHistoryListResponseSchema,
  agentIdentityHistoryRestoreRequestSchema,
  agentIdentityHistoryRestoreResponseSchema,
  agentIdentityListRequestSchema,
  agentIdentityListResponseSchema,
  agentIdentitySkillsImportRequestSchema,
  agentIdentitySkillsImportResponseSchema,
  agentIdentitySkillsInspectRequestSchema,
  agentIdentitySkillsInspectResponseSchema,
  agentIdentityUpdateRequestSchema,
  agentIdentityUpdateResponseSchema,
} from "@traycer/protocol/host/agent-identity/unary-schemas";

export const agentIdentityListV10 = defineRpcContract({
  method: "agentIdentity.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentIdentityListRequestSchema,
  responseSchema: agentIdentityListResponseSchema,
});

export const agentIdentityCreateV10 = defineRpcContract({
  method: "agentIdentity.create",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentIdentityCreateRequestSchema,
  responseSchema: agentIdentityCreateResponseSchema,
});

export const agentIdentityUpdateV10 = defineRpcContract({
  method: "agentIdentity.update",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentIdentityUpdateRequestSchema,
  responseSchema: agentIdentityUpdateResponseSchema,
});

export const agentIdentityDeleteV10 = defineRpcContract({
  method: "agentIdentity.delete",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentIdentityDeleteRequestSchema,
  responseSchema: agentIdentityDeleteResponseSchema,
});

export const agentIdentityFilesAddV10 = defineRpcContract({
  method: "agentIdentity.files.add",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentIdentityFilesAddRequestSchema,
  responseSchema: agentIdentityFilesAddResponseSchema,
});

export const agentIdentityFilesRenameV10 = defineRpcContract({
  method: "agentIdentity.files.rename",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentIdentityFilesRenameRequestSchema,
  responseSchema: agentIdentityFilesRenameResponseSchema,
});

export const agentIdentityFilesDeleteV10 = defineRpcContract({
  method: "agentIdentity.files.delete",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentIdentityFilesDeleteRequestSchema,
  responseSchema: agentIdentityFilesDeleteResponseSchema,
});

export const agentIdentityFilesUploadBlobV10 = defineRpcContract({
  method: "agentIdentity.files.uploadBlob",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentIdentityFilesUploadBlobRequestSchema,
  responseSchema: agentIdentityFilesUploadBlobResponseSchema,
});

export const agentIdentityFilesReadBlobV10 = defineRpcContract({
  method: "agentIdentity.files.readBlob",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentIdentityFilesReadBlobRequestSchema,
  responseSchema: agentIdentityFilesReadBlobResponseSchema,
});

export const agentIdentityHistoryListV10 = defineRpcContract({
  method: "agentIdentity.history.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentIdentityHistoryListRequestSchema,
  responseSchema: agentIdentityHistoryListResponseSchema,
});

export const agentIdentityHistoryRestoreV10 = defineRpcContract({
  method: "agentIdentity.history.restore",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentIdentityHistoryRestoreRequestSchema,
  responseSchema: agentIdentityHistoryRestoreResponseSchema,
});

export const agentIdentitySkillsInspectV10 = defineRpcContract({
  method: "agentIdentity.skills.inspect",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentIdentitySkillsInspectRequestSchema,
  responseSchema: agentIdentitySkillsInspectResponseSchema,
});

export const agentIdentitySkillsImportV10 = defineRpcContract({
  method: "agentIdentity.skills.import",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentIdentitySkillsImportRequestSchema,
  responseSchema: agentIdentitySkillsImportResponseSchema,
});
