import { createContext, useContext } from "react";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import type { FileEditReason } from "@traycer/protocol/persistence/epic/content-blocks";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useCloudChatPayload } from "@/hooks/chats/use-cloud-chat-queries";
import type { CloudChatPayloadBytes } from "@/lib/chats/cloud-chat-payloads";

/**
 * Context for published-chat heavy content. Default `null` is live: consumers dispatch without hooks so a disabled cloud query is never mounted.
 */

export interface PublishedChatSource {
  /** The triple every cloud read is addressed by. */
  readonly identity: CloudChatIdentity;
  /** The tab's host client - the one serving this tile's byte pipe. */
  readonly client: HostClient<HostRpcRegistry> | null;
}

/**
 * Exported so {@link PublishedChatSourceProvider} can live in its own module: this file holds hooks and helpers, and a file that exports BOTH components and non-components breaks fast refresh for every consumer of it.
 */
export const PublishedChatSourceContext =
  createContext<PublishedChatSource | null>(null);

/** The published source for this subtree, or `null` on every live surface. */
export function usePublishedChatSource(): PublishedChatSource | null {
  return useContext(PublishedChatSourceContext);
}

/** A published file_change's before/after text, in the shape `useSnapshotDiffQuery` already returns. */
export interface PublishedSnapshotDiff {
  readonly data:
    | {
        readonly beforeContent: string | null;
        readonly afterContent: string | null;
        readonly reason: FileEditReason;
      }
    | undefined;
  readonly isLoading: boolean;
  /** Set when either side was served as a prefix. See {@link PayloadExtent}. */
  readonly truncation: PayloadExtent | null;
  /**
   * Set when a side's read FAILED rather than answered.
   * Mutually exclusive with `data`: a diff missing one of its halves is not a diff.
   */
  readonly failure: PayloadReadFailure | null;
}

/** A read that failed on the WIRE, carrying the only thing a reader can do about it. */
export interface PayloadReadFailure {
  /** Re-issues the reads that failed - and only those. */
  readonly retry: () => void;
}

/** One side's answer, as much of a payload query as the derivation reads. */
interface SnapshotSideAnswer {
  /** The decoder's union, so a contract change reaches this file as an error. */
  readonly data: CloudChatPayloadBytes | undefined;
  readonly isError: boolean;
}

/** Whether a side this block ACTUALLY asked for failed on the wire. */
function sideFailed(hash: string | null, side: SnapshotSideAnswer): boolean {
  return hash !== null && side.isError;
}

/**
 * The two payload answers turned into the segment's shape - the whole tail of {@link usePublishedSnapshotDiff}, lifted out because that hook's branching (two queries, a pending rule, a missing rule and a truncation rule) was over this repo's complexity ceiling.
 */
function snapshotDiffResult(input: {
  readonly enabled: boolean;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly before: SnapshotSideAnswer;
  readonly after: SnapshotSideAnswer;
  /** Handed in rather than derived, so this stays a pure function of answers. */
  readonly retry: () => void;
}): PublishedSnapshotDiff {
  if (!input.enabled) {
    return {
      data: undefined,
      isLoading: false,
      truncation: null,
      failure: null,
    };
  }
  const beforePending =
    input.beforeHash !== null && input.before.data === undefined;
  const afterPending =
    input.afterHash !== null && input.after.data === undefined;
  if (
    (beforePending && !input.before.isError) ||
    (afterPending && !input.after.isError)
  ) {
    return {
      data: undefined,
      isLoading: true,
      truncation: null,
      failure: null,
    };
  }
  // A side that FAILED has produced no evidence about its blob, so neither half of the answer below is available: `payloadText` would read its absent data as `null` and the diff would report `blob_missing` - a permanent verdict for a retryable fault.
  if (
    sideFailed(input.beforeHash, input.before) ||
    sideFailed(input.afterHash, input.after)
  ) {
    return {
      data: undefined,
      isLoading: false,
      truncation: null,
      failure: { retry: input.retry },
    };
  }
  const beforeText = payloadText(input.before.data);
  const afterText = payloadText(input.after.data);
  // A hash the block names but the cloud REFUSED to serve is the same fact the
  // local store reports as a missing blob, and the segment already draws it.
  const missing =
    (input.beforeHash !== null && beforeText === null) ||
    (input.afterHash !== null && afterText === null);
  return {
    data: {
      beforeContent: beforeText,
      afterContent: afterText,
      reason: missing ? "blob_missing" : "snapshot",
    },
    isLoading: false,
    // Either side being a prefix makes the DIFF partial - a complete "after"
    // against a truncated "before" invents changes at the cut.
    truncation:
      payloadExtent(input.after.data) ?? payloadExtent(input.before.data),
    failure: null,
  };
}

export function usePublishedSnapshotDiff(args: {
  readonly source: PublishedChatSource | null;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly enabled: boolean;
}): PublishedSnapshotDiff {
  const identity = args.source?.identity ?? null;
  const client = args.source?.client ?? null;
  const before = useCloudChatPayload({
    client,
    identity,
    ref:
      args.beforeHash === null
        ? null
        : { kind: "file-snapshot", sha256: args.beforeHash },
    enabled: args.enabled && args.beforeHash !== null,
  });
  const after = useCloudChatPayload({
    client,
    identity,
    ref:
      args.afterHash === null
        ? null
        : { kind: "file-snapshot", sha256: args.afterHash },
    enabled: args.enabled && args.afterHash !== null,
  });
  // Only the sides that FAILED are re-issued.
  // A payload is content-addressed, so a side that answered holds bytes that cannot become different bytes - refetching it would spend a request to receive what it already has.
  const retry = (): void => {
    if (before.isError) void before.refetch();
    if (after.isError) void after.refetch();
  };
  return snapshotDiffResult({
    enabled: args.enabled,
    beforeHash: args.beforeHash,
    afterHash: args.afterHash,
    before,
    after,
    retry,
  });
}

/** A published plan's full markdown, or `null` when the cloud cannot serve it. */
export function usePublishedPlanContent(args: {
  readonly source: PublishedChatSource | null;
  readonly contentHash: string | null;
  readonly enabled: boolean;
}): {
  readonly markdown: string | null;
  readonly isLoading: boolean;
  readonly truncation: PayloadExtent | null;
  readonly failure: PayloadReadFailure | null;
} {
  const query = useCloudChatPayload({
    client: args.source?.client ?? null,
    identity: args.source?.identity ?? null,
    ref:
      args.contentHash === null
        ? null
        : { kind: "plan-content", sha256: args.contentHash },
    enabled: args.enabled && args.contentHash !== null,
  });
  if (!args.enabled || args.contentHash === null) {
    return {
      markdown: null,
      isLoading: false,
      truncation: null,
      failure: null,
    };
  }
  if (query.data === undefined && !query.isError) {
    return { markdown: null, isLoading: true, truncation: null, failure: null };
  }
  if (query.isError) {
    return {
      markdown: null,
      isLoading: false,
      truncation: null,
      failure: {
        retry: () => {
          void query.refetch();
        },
      },
    };
  }
  return {
    markdown: payloadText(query.data),
    isLoading: false,
    truncation: payloadExtent(query.data),
    failure: null,
  };
}

/** How much of a payload this actually is. */
export interface PayloadExtent {
  readonly isTruncated: boolean;
  readonly byteLength: number;
}

function payloadExtent(
  // The decoder's own union, not a structural echo of it.
  // Optional fields here would keep compiling if `text` ever stopped carrying `isTruncated` - and the truncation notice would just stop appearing, which is the one failure this whole path exists to prevent.
  payload: CloudChatPayloadBytes | undefined,
): PayloadExtent | null {
  if (payload === undefined) return null;
  if (payload.kind !== "text") return null;
  if (!payload.isTruncated) return null;
  return { isTruncated: true, byteLength: payload.byteLength };
}

/** The notice a partial payload earns, in the words the demolished viewer used. */
export function payloadTruncationNotice(extent: PayloadExtent): string {
  return `Showing the first part of ${extent.byteLength} bytes.`;
}

/** Text out of a payload, or `null` for every answer that is not text. */
function payloadText(
  payload: CloudChatPayloadBytes | undefined,
): string | null {
  if (payload === undefined) return null;
  if (payload.kind !== "text") return null;
  return payload.text;
}
