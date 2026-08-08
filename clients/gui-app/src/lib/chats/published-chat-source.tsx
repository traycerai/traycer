import { createContext, useContext, type ReactNode } from "react";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import type { FileEditReason } from "@traycer/protocol/persistence/epic/content-blocks";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useCloudChatPayload } from "@/hooks/chats/use-cloud-chat-queries";

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
 * Both consumers call both hooks unconditionally and pick between the results.
 * Hook order stays stable, there are no conditional imports, and there is no
 * third data path: exactly one of the two is enabled at a time.
 */

export interface PublishedChatSource {
  /** The triple every cloud read is addressed by. */
  readonly identity: CloudChatIdentity;
  /** The tab's host client - the one serving this tile's byte pipe. */
  readonly client: HostClient<HostRpcRegistry> | null;
}

const PublishedChatSourceContext = createContext<PublishedChatSource | null>(
  null,
);

export function PublishedChatSourceProvider(props: {
  readonly source: PublishedChatSource;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <PublishedChatSourceContext.Provider value={props.source}>
      {props.children}
    </PublishedChatSourceContext.Provider>
  );
}

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
export function usePublishedSnapshotDiff(args: {
  readonly source: PublishedChatSource | null;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly enabled: boolean;
}): {
  readonly data:
    | {
        readonly beforeContent: string | null;
        readonly afterContent: string | null;
        readonly reason: FileEditReason;
      }
    | undefined;
  readonly isLoading: boolean;
} {
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
  if (!args.enabled) return { data: undefined, isLoading: false };
  const beforePending = args.beforeHash !== null && before.data === undefined;
  const afterPending = args.afterHash !== null && after.data === undefined;
  if ((beforePending && !before.isError) || (afterPending && !after.isError)) {
    return { data: undefined, isLoading: true };
  }
  const beforeText = payloadText(before.data);
  const afterText = payloadText(after.data);
  // A hash the block names but the cloud cannot serve is the same fact the
  // local store reports as a missing blob, and the segment already draws it.
  const missing =
    (args.beforeHash !== null && beforeText === null) ||
    (args.afterHash !== null && afterText === null);
  return {
    data: {
      beforeContent: beforeText,
      afterContent: afterText,
      reason: missing ? "blob_missing" : "snapshot",
    },
    isLoading: false,
  };
}

/** A published plan's full markdown, or `null` when the cloud cannot serve it. */
export function usePublishedPlanContent(args: {
  readonly source: PublishedChatSource | null;
  readonly contentHash: string | null;
  readonly enabled: boolean;
}): { readonly markdown: string | null; readonly isLoading: boolean } {
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
    return { markdown: null, isLoading: false };
  }
  if (query.data === undefined && !query.isError) {
    return { markdown: null, isLoading: true };
  }
  return { markdown: payloadText(query.data), isLoading: false };
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
  payload: { readonly kind: string; readonly text?: string } | undefined,
): string | null {
  if (payload === undefined) return null;
  if (payload.kind !== "text") return null;
  return payload.text ?? null;
}
