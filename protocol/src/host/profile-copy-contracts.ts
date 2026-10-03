import { z } from "zod";
import {
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
  type DowngradeResult,
} from "../framework/index";
import type { ConnectionManifest } from "../framework/ws-protocol";
import { advertisedMajors } from "../framework/compat-helpers";
import * as schemas from "./profile-copy-schemas";
import * as v1 from "./profile-copy-schemas-v1";

/** Copy 1.0 stays frozen. Major 2 accepts canonical opaque host ids in both
 * requests and receipts. The identity upgrade preserves authority bytes;
 * downgrade refuses values an older peer cannot represent, without rewriting
 * ids or letting a new receipt reach the old parser under the same version.
 * No incomplete handler may be registered: deriveHostManifest advertises only
 * attached implementations. This optional family stays off the released floor.
 */
function defineProfileCopyMethod<
  const Method extends string,
  RequestSchema extends z.ZodType<object>,
  ResponseSchema extends z.ZodType<object>,
>(
  method: Method,
  requestV1: RequestSchema,
  responseV1: ResponseSchema,
  requestV2: RequestSchema,
  responseV2: ResponseSchema,
) {
  const previous = defineRpcContract({
    method,
    schemaVersion: { major: 1, minor: 0 },
    requestSchema: requestV1,
    responseSchema: responseV1,
  });
  const current = defineRpcContract({
    method,
    schemaVersion: { major: 2, minor: 0 },
    requestSchema: requestV2,
    responseSchema: responseV2,
  });
  // Both contracts use this one method argument. Widen only the bridge's
  // method type so the framework's same-method conditional can resolve inside
  // this generic factory; registry contracts retain the caller's literal.
  type PreviousBridge = Omit<typeof previous, "method"> & { method: string };
  type CurrentBridge = Omit<typeof current, "method"> & { method: string };
  const upgrade = defineUpgradePath<PreviousBridge, CurrentBridge>({
    from: previous.schemaVersion,
    to: current.schemaVersion,
    upgradeRequest: (request) => request,
    upgradeResponse: (response) => response,
  });
  const downgrade = defineDowngradePath<CurrentBridge, PreviousBridge>({
    from: current.schemaVersion,
    to: previous.schemaVersion,
    downgradeRequest: (request) => projectCopyV1(requestV1, request),
    downgradeResponse: (response) => projectCopyV1(responseV1, response),
  });
  return {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: previous, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 0,
      versions: {
        0: { contract: current, upgradeFromPreviousVersion: upgrade },
      },
      downgradePathsFromLatest: { 1: downgrade },
    },
  } as const;
}

function projectCopyV1<Schema extends z.ZodType<object>>(
  schema: Schema,
  value: z.output<Schema>,
): DowngradeResult<z.output<Schema>> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: {
      code: "DOWNGRADE_UNSUPPORTED",
      message: "This copy requires a peer that supports opaque host ids",
    },
  };
}

export const PROFILE_COPY_RPC_METHODS = {
  "providers.profileCopy.preview": defineProfileCopyMethod(
    "providers.profileCopy.preview",
    v1.profileCopyPreviewRequestSchema,
    v1.profileCopyPreviewResponseSchema,
    schemas.profileCopyPreviewRequestSchema,
    schemas.profileCopyPreviewResponseSchema,
  ),
  "providers.profileCopy.start": defineProfileCopyMethod(
    "providers.profileCopy.start",
    v1.profileCopyStartRequestSchema,
    v1.profileCopyOperationResponseSchema,
    schemas.profileCopyStartRequestSchema,
    schemas.profileCopyOperationResponseSchema,
  ),
  "providers.profileCopy.status": defineProfileCopyMethod(
    "providers.profileCopy.status",
    v1.profileCopyOperationRequestSchema,
    v1.profileCopyOperationResponseSchema,
    schemas.profileCopyOperationRequestSchema,
    schemas.profileCopyOperationResponseSchema,
  ),
  "providers.profileCopy.cancel": defineProfileCopyMethod(
    "providers.profileCopy.cancel",
    v1.profileCopyOperationRequestSchema,
    v1.profileCopyOperationResponseSchema,
    schemas.profileCopyOperationRequestSchema,
    schemas.profileCopyOperationResponseSchema,
  ),
  "providers.profileCopy.incoming": defineProfileCopyMethod(
    "providers.profileCopy.incoming",
    v1.profileCopyIncomingRequestSchema,
    v1.profileCopyIncomingResponseSchema,
    schemas.profileCopyIncomingRequestSchema,
    schemas.profileCopyIncomingResponseSchema,
  ),
  "providers.profileCopy.draftStatus": defineProfileCopyMethod(
    "providers.profileCopy.draftStatus",
    v1.profileCopyDraftRequestSchema,
    v1.profileCopyDraftResponseSchema,
    schemas.profileCopyDraftRequestSchema,
    schemas.profileCopyDraftResponseSchema,
  ),
  "providers.profileCopy.cancelDraft": defineProfileCopyMethod(
    "providers.profileCopy.cancelDraft",
    v1.profileCopyRevisionRequestSchema,
    v1.profileCopyDraftResponseSchema,
    schemas.profileCopyRevisionRequestSchema,
    schemas.profileCopyDraftResponseSchema,
  ),
  "providers.profileCopy.setPreference": defineProfileCopyMethod(
    "providers.profileCopy.setPreference",
    v1.profileCopyPreferenceRequestSchema,
    v1.profileCopyDraftResponseSchema,
    schemas.profileCopyPreferenceRequestSchema,
    schemas.profileCopyDraftResponseSchema,
  ),
  "providers.profileCopy.verify": defineProfileCopyMethod(
    "providers.profileCopy.verify",
    v1.profileCopyRevisionRequestSchema,
    v1.profileCopyDraftResponseSchema,
    schemas.profileCopyRevisionRequestSchema,
    schemas.profileCopyDraftResponseSchema,
  ),
  "providers.profileCopy.confirmVerification": defineProfileCopyMethod(
    "providers.profileCopy.confirmVerification",
    v1.profileCopyVerificationDecisionRequestSchema,
    v1.profileCopyDraftResponseSchema,
    schemas.profileCopyVerificationDecisionRequestSchema,
    schemas.profileCopyDraftResponseSchema,
  ),
  "providers.profileCopy.confirmIdentity": defineProfileCopyMethod(
    "providers.profileCopy.confirmIdentity",
    v1.profileCopyIdentityDecisionRequestSchema,
    v1.profileCopyDraftResponseSchema,
    schemas.profileCopyIdentityDecisionRequestSchema,
    schemas.profileCopyDraftResponseSchema,
  ),
  "providers.profileCopy.retry": defineProfileCopyMethod(
    "providers.profileCopy.retry",
    v1.profileCopyRetryRequestSchema,
    v1.profileCopyDraftResponseSchema,
    schemas.profileCopyRetryRequestSchema,
    schemas.profileCopyDraftResponseSchema,
  ),
  "providers.profileCopy.login.start": defineProfileCopyMethod(
    "providers.profileCopy.login.start",
    v1.profileCopyRevisionRequestSchema,
    v1.profileCopyLoginResponseSchema,
    schemas.profileCopyRevisionRequestSchema,
    schemas.profileCopyLoginResponseSchema,
  ),
  "providers.profileCopy.login.await": defineProfileCopyMethod(
    "providers.profileCopy.login.await",
    v1.profileCopyLoginControlRequestSchema,
    v1.profileCopyLoginResponseSchema,
    schemas.profileCopyLoginControlRequestSchema,
    schemas.profileCopyLoginResponseSchema,
  ),
  "providers.profileCopy.login.touch": defineProfileCopyMethod(
    "providers.profileCopy.login.touch",
    v1.profileCopyLoginControlRequestSchema,
    v1.profileCopyLoginResponseSchema,
    schemas.profileCopyLoginControlRequestSchema,
    schemas.profileCopyLoginResponseSchema,
  ),
  "providers.profileCopy.login.submitCode": defineProfileCopyMethod(
    "providers.profileCopy.login.submitCode",
    v1.profileCopySubmitCodeRequestSchema,
    v1.profileCopyLoginResponseSchema,
    schemas.profileCopySubmitCodeRequestSchema,
    schemas.profileCopyLoginResponseSchema,
  ),
  "providers.profileCopy.login.cancel": defineProfileCopyMethod(
    "providers.profileCopy.login.cancel",
    v1.profileCopyLoginControlRequestSchema,
    v1.profileCopyLoginResponseSchema,
    schemas.profileCopyLoginControlRequestSchema,
    schemas.profileCopyLoginResponseSchema,
  ),
  "host.profileCopy.preflight": defineProfileCopyMethod(
    "host.profileCopy.preflight",
    v1.hostProfileCopyPreflightRequestSchema,
    v1.hostProfileCopyPreflightResponseSchema,
    schemas.hostProfileCopyPreflightRequestSchema,
    schemas.hostProfileCopyPreflightResponseSchema,
  ),
  "host.profileCopy.import": defineProfileCopyMethod(
    "host.profileCopy.import",
    v1.hostProfileCopyImportRequestSchema,
    v1.hostProfileCopyReceiptResponseSchema,
    schemas.hostProfileCopyImportRequestSchema,
    schemas.hostProfileCopyReceiptResponseSchema,
  ),
  "host.profileCopy.receipt": defineProfileCopyMethod(
    "host.profileCopy.receipt",
    v1.profileCopyDraftRequestSchema,
    v1.hostProfileCopyReceiptResponseSchema,
    schemas.profileCopyDraftRequestSchema,
    schemas.hostProfileCopyReceiptResponseSchema,
  ),
  "host.profileCopy.cancel": defineProfileCopyMethod(
    "host.profileCopy.cancel",
    v1.profileCopyDraftRequestSchema,
    v1.hostProfileCopyReceiptResponseSchema,
    schemas.profileCopyDraftRequestSchema,
    schemas.hostProfileCopyReceiptResponseSchema,
  ),
} as const;

export type ProfileCopyMethod =
  | keyof typeof PROFILE_COPY_RPC_METHODS
  | "host.profileCopy.applySync";

export const PROFILE_COPY_INTERNAL_METHODS = [
  "host.profileCopy.preflight",
  "host.profileCopy.import",
  "host.profileCopy.receipt",
  "host.profileCopy.cancel",
  "host.profileCopy.applySync",
] as const;

/** A wire-only gate. Consult live route/adapter admission separately and recheck
 * at start. Caller supplies each peer's actually served, handshake manifest;
 * never substitute the shared installed registry. No credential dispatch is
 * possible through this helper. Missing or incompatible methods mean update.
 */
export function profileCopyMethodSupport(
  sourceManifest: ConnectionManifest | null,
  destinationManifest: ConnectionManifest | null,
  sourceMethods: readonly ProfileCopyMethod[],
  destinationMethods: readonly ProfileCopyMethod[],
): "supported" | "update-required" {
  for (const [manifest, methods] of [
    [sourceManifest, sourceMethods],
    [destinationManifest, destinationMethods],
  ] as const) {
    for (const method of methods) {
      const entry = manifest?.[method];
      const supported = method === "host.profileCopy.applySync" ? [1] : [1, 2];
      if (
        entry === undefined ||
        !advertisedMajors(entry).some((major) => supported.includes(major))
      ) {
        return "update-required";
      }
    }
  }
  return "supported";
}
