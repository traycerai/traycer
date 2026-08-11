import { createContext, useContext } from "react";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import type { FileEditReason } from "@traycer/protocol/persistence/epic/content-blocks";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useCloudChatPayload } from "@/hooks/chats/use-cloud-chat-queries";
import type { CloudChatPayloadBytes } from "@/lib/chats/cloud-chat-payloads";

/**
 * Where a chat surface's HEAVY content comes from, when it is not this
 * machine's own stores.
 *
 * ## Why a context rather than a prop or a smarter adapter
 *
 * A chat's diffs and full plans are not in the chat document. The blocks carry
 * content-addressed hashes, and the components that expand them
 * (`FileChangeInlineDiff`, the plan modal) fetch by hash from the LOCAL host's
 * snapshot store and the tab host's `agent.gui.getPlan`. That is right for a
 * live chat and wrong for a published copy of someone else's: the reading host
 * does not hold the owner's blobs, so expanding one reported `blob_missing`
 * for content that was sitting in the cloud the whole time.
 *
 * The fetch decision lives INSIDE those segments, several layers below anything
 * the tile hands down, and they are shared with every live chat - so the source
 * cannot be threaded as a prop without touching every intermediate renderer.
 * A context is the seam that reaches them without doing that.
 *
 * ## Null is the live path, and it is byte-identical
 *
 * The default is `null` and nothing provides it except a published tile. A live
 * chat therefore behaves exactly as before: the cloud hooks below are mounted
 * but DISABLED, so no cloud request is ever issued and no query key is created.
 * That is the property `published-chat-source.test.tsx` pins - not "the live
 * path still works", but "the cloud reader is never consulted".
 *
 * Each consumer DISPATCHES on the context without hooks, into a live sibling
 * and a published one - the shape `ChatNodeShell` already uses. Two arms inside
 * one component was the first design and it failed its own purpose: a
 * mounted-but-disabled cloud query still creates an observer and still demands
 * a `QueryClientProvider`, which three untouched segment suites proved by going
 * red. A component boundary means the live arm is the code that shipped, mounts
 * nothing extra, and a transcript holding dozens of file-change blocks pays for
 * none of them.
 */

export interface PublishedChatSource {
  /** The triple every cloud read is addressed by. */
  readonly identity: CloudChatIdentity;
  /** The tab's host client - the one serving this tile's byte pipe. */
  readonly client: HostClient<HostRpcRegistry> | null;
}

/**
 * Exported so {@link PublishedChatSourceProvider} can live in its own module:
 * this file holds hooks and helpers, and a file that exports BOTH components
 * and non-components breaks fast refresh for every consumer of it.
 */
export const PublishedChatSourceContext =
  createContext<PublishedChatSource | null>(null);

/** The published source for this subtree, or `null` on every live surface. */
export function usePublishedChatSource(): PublishedChatSource | null {
  return useContext(PublishedChatSourceContext);
}

/**
 * A published file_change's before/after text, in the shape
 * `useSnapshotDiffQuery` already returns.
 *
 * Matching that shape is deliberate: the segment's rendering, its spinner rule
 * and its reason copy stay untouched, and the only thing that differs between a
 * live chat and a published one is which of two disabled-or-enabled queries
 * answered.
 *
 * `reason` is derived rather than carried. A cloud payload arrives as bytes or
 * as an explicit unavailability, and those map onto the reasons this surface
 * already draws - so a published diff whose blob was never uploaded renders the
 * same banner a local one does, rather than a new vocabulary for the same fact.
 */
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
}

/** One side's answer, as much of a payload query as the derivation reads. */
interface SnapshotSideAnswer {
  /** The decoder's union, so a contract change reaches this file as an error. */
  readonly data: CloudChatPayloadBytes | undefined;
  readonly isError: boolean;
}

/**
 * The two payload answers turned into the segment's shape - the whole tail of
 * {@link usePublishedSnapshotDiff}, lifted out because that hook's branching
 * (two queries, a pending rule, a missing rule and a truncation rule) was over
 * this repo's complexity ceiling. Pure, and the checks are in their original
 * order.
 */
function snapshotDiffResult(input: {
  readonly enabled: boolean;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly before: SnapshotSideAnswer;
  readonly after: SnapshotSideAnswer;
}): PublishedSnapshotDiff {
  if (!input.enabled) {
    return { data: undefined, isLoading: false, truncation: null };
  }
  const beforePending =
    input.beforeHash !== null && input.before.data === undefined;
  const afterPending =
    input.afterHash !== null && input.after.data === undefined;
  if (
    (beforePending && !input.before.isError) ||
    (afterPending && !input.after.isError)
  ) {
    return { data: undefined, isLoading: true, truncation: null };
  }
  const beforeText = payloadText(input.before.data);
  const afterText = payloadText(input.after.data);
  // A hash the block names but the cloud cannot serve is the same fact the
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
  return snapshotDiffResult({
    enabled: args.enabled,
    beforeHash: args.beforeHash,
    afterHash: args.afterHash,
    before,
    after,
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
    return { markdown: null, isLoading: false, truncation: null };
  }
  if (query.data === undefined && !query.isError) {
    return { markdown: null, isLoading: true, truncation: null };
  }
  return {
    markdown: payloadText(query.data),
    isLoading: false,
    truncation: payloadExtent(query.data),
  };
}

/**
 * How much of a payload this actually is.
 *
 * The cloud reader deliberately serves a bounded PREFIX of a large payload and
 * says so on the response. Dropping that flag was a restoration regression in
 * the strictest sense: the viewer this ticket demolished rendered a truncation
 * notice, so a surface that silently presents 64 KiB of a 65,547-byte file as
 * the whole thing is worse than the thing it replaced. Every consumer of these
 * hooks must be able to say "this is a prefix", so it travels beside the text
 * rather than being folded into it.
 */
export interface PayloadExtent {
  readonly isTruncated: boolean;
  readonly byteLength: number;
}

function payloadExtent(
  // The decoder's own union, not a structural echo of it. Optional fields here
  // would keep compiling if `text` ever stopped carrying `isTruncated` - and
  // the truncation notice would just stop appearing, which is the one failure
  // this whole path exists to prevent.
  payload: CloudChatPayloadBytes | undefined,
): PayloadExtent | null {
  if (payload === undefined) return null;
  if (payload.kind !== "text") return null;
  if (!payload.isTruncated) return null;
  return { isTruncated: true, byteLength: payload.byteLength };
}

/**
 * The notice a partial payload earns, in the words the demolished viewer used.
 *
 * Kept as one function so the diff and the plan cannot drift into describing
 * the same limit two ways.
 */
export function payloadTruncationNotice(extent: PayloadExtent): string {
  return `Showing the first part of ${extent.byteLength} bytes.`;
}

/**
 * Text out of a payload, or `null` for every answer that is not text.
 *
 * `unavailable`, `digest-mismatch` and `ambiguous-identity` collapse here on
 * purpose: they are different facts, a reader can act on none of them
 * differently, and the surfaces above already have one marker for "this content
 * is not here".
 */
function payloadText(
  payload: CloudChatPayloadBytes | undefined,
): string | null {
  if (payload === undefined) return null;
  if (payload.kind !== "text") return null;
  return payload.text;
}
