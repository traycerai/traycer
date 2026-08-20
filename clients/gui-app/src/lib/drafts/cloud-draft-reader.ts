import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import type { CloudChatReadPort } from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import {
  utf8Bytes,
  type Sha256Hex,
} from "@traycer-clients/shared/cloud-chat/bytes";
import {
  decodeDraftHeadDocument,
  DRAFT_HEAD_DOCUMENT_CORRUPTION_MESSAGES,
  type DraftHeadDocumentCorruptionReason,
} from "@traycer/protocol/persistence/draft/document";
import type { DraftHeadReaderRecord } from "@traycer/protocol/persistence/draft/schemas";

/**
 * Byte-pipe read of a published draft head. Same digest-before-parse
 * discipline as `readCloudChat`; draft/v1 names no shards so this spends
 * no part egress.
 */
export interface ReadCloudDraftOptions {
  readonly identity: CloudChatIdentity;
  readonly port: CloudChatReadPort;
  readonly sha256Hex: Sha256Hex;
}

export type CloudDraftReadOutcome =
  | { readonly kind: "ok"; readonly record: DraftHeadReaderRecord }
  | { readonly kind: "unpublished" }
  | {
      readonly kind: "needs-newer-app";
      readonly message: string;
    }
  | {
      readonly kind: "ambiguous-identity";
      readonly resolvedOwnerUserId: string | null;
    }
  | {
      readonly kind: "corrupt";
      readonly reason:
        DraftHeadDocumentCorruptionReason | "head-digest-mismatch";
      readonly message: string;
      readonly diagnostic: string;
    };

export async function readCloudDraft(
  options: ReadCloudDraftOptions,
): Promise<CloudDraftReadOutcome> {
  const resolved = await options.port.resolveHead(options.identity);
  const { outcome } = resolved;
  if (outcome.status === "unpublished" || outcome.status === "missing") {
    return { kind: "unpublished" };
  }
  if (outcome.status === "ambiguous-identity") {
    return {
      kind: "ambiguous-identity",
      resolvedOwnerUserId: outcome.resolvedOwnerUserId,
    };
  }
  const documentDigest = await options.sha256Hex(utf8Bytes(outcome.head));
  if (documentDigest !== outcome.headSha256) {
    return {
      kind: "corrupt",
      reason: "head-digest-mismatch",
      message:
        "This draft's stored record did not match its expected contents and could not be opened.",
      diagnostic: `Head document hashes to ${documentDigest} but the row promises ${outcome.headSha256}`,
    };
  }
  const decoded = decodeDraftHeadDocument(outcome.head);
  if (decoded.status === "corrupt") {
    if (decoded.reason === "schema-rejected") {
      return {
        kind: "needs-newer-app",
        message: decoded.message,
      };
    }
    return {
      kind: "corrupt",
      reason: decoded.reason,
      message: DRAFT_HEAD_DOCUMENT_CORRUPTION_MESSAGES[decoded.reason],
      diagnostic: decoded.diagnostic,
    };
  }
  return { kind: "ok", record: decoded.record };
}
