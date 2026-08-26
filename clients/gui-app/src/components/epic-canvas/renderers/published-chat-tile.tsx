import { useMemo, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ChatReplicaReadResponse } from "@traycer/protocol/host/epic/chat-replica-read";
import type { CloudChatRead } from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { PublishedChatTileRef } from "@/stores/epics/canvas/types";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useBoundedHostLoad } from "@/hooks/host/use-bounded-host-load";
import { TileHostLoadState } from "./tile-host-load-state";
import {
  useHostReachability,
  resolvedHostLabel,
  type HostReachabilityStatus,
} from "@/hooks/agent/use-host-reachability";
import { useCloudChatTranscript } from "@/hooks/chats/use-cloud-chat-transcript";
import { useChatReplicaRead } from "@/hooks/chats/use-chat-replica-read";
import { describeCloudChatRefusal } from "@/lib/chats/cloud-chat-refusal";
import { isCloudChatsUnsupported } from "@/lib/chats/cloud-chat-read-port";
import {
  convertPublishedChat,
  convertReplicaChat,
  createPublishedChatSessionHandle,
} from "@/lib/chats/published-chat-session";
import { ChatDeadTileBannerContainer, ChatTileSessionView } from "./chat-tile";
import { PublishedChatNotice } from "./published-chat-notice";
import { PublishedChatSourceProvider } from "@/lib/chats/published-chat-source-provider";
import {
  publishedChatLockReason,
  replicaChatLockReason,
} from "@/components/epic-canvas/renderers/published-chat-lock-reason";
import { useOwnedByViewer } from "@/hooks/chats/use-owned-by-viewer";

/**
 * A chat whose owning host is out of reach, rendered through the ORDINARY chat
 * surface from the last copy that host published.
 *
 * ## One surface, two data sources
 *
 * This is not a second chat view. It resolves a `ChatSessionStoreHandle` from
 * the cloud read instead of from a live `chat.subscribe` stream and hands it to
 * the same `ChatTileSessionView` a live tile uses, so messages, blocks,
 * thinking, tools and scroll are literally the same components. The only
 * intentional difference is the composer, which is locked with a reason naming
 * the host, its state, and what the reader is looking at.
 *
 * ## The host binding is untouched
 *
 * The tile reads through the TAB's host client. The cloud read is a byte pipe -
 * any host the device can reach serves it, which is exactly what makes an
 * offline owner readable - but "any host" is chosen once, at open, and recorded
 * on the ref; it must not follow the app's active host afterwards. Nothing here
 * binds the OWNING host, so the tab-host-for-life rule is not bent; the owner is
 * row metadata that the notice names and nothing addresses.
 *
 * ## The doc-replica fallback (unreachable-owner view, ticket 34A)
 *
 * A chat this host neither owns nor has ever published still syncs into the
 * epic Y.Doc through ordinary collaboration, so when the cloud read settles
 * `unpublished` - and only then, no other refusal is masked - the tile asks
 * the SAME serving host to read its own doc replica. "Unpublished" is wider
 * than its name: per `cloud-chat-reader.ts`, it also covers the server
 * declining to serve THIS viewer the row (a missing row and a not-readable
 * one answer identically by design, so the client cannot and does not try to
 * tell them apart) - the replica fallback fires in that case too, which is
 * the right behavior (a synced copy this device can read is not made wrong by
 * the cloud saying nothing), just not literally "never published".
 *
 * Doc messages DO carry the same content-addressed hashes a published
 * transcript's do - what a doc row lacks is a PUBLICATION to redirect a
 * fetch to, which is `PublishedChatSourceProvider`'s only job. This branch
 * renders without it, so a block that names heavy content falls through to
 * the surface's ordinary local-store lookup and reads `blob_missing` if nothing
 * local has that hash - the honest outcome for a host that has the chat's
 * text but not the file bytes a wholly different host attached to it.
 */

export interface PublishedChatTileProps {
  readonly node: PublishedChatTileRef;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly isActive: boolean;
  readonly epicId: string;
}

export function PublishedChatTile(props: PublishedChatTileProps): ReactNode {
  const { node } = props;
  // The TAB's client, not the app's. The ref records which host was chosen to
  // serve this read at open, and `renderTile` binds exactly that host - so the
  // app-wide client silently moved an open tab's cloud reads onto whatever host
  // became active later, taking its credential and its capabilities with it. A
  // previously readable tab could turn unsupported without anything about the
  // chat changing. Host-for-life applies to the serving host too.
  const client = useTabHostClient();
  // The host SERVING this copy - the one `client` addresses and the one whose
  // absence is what leaves the reads pending. Deliberately distinct from
  // `ownerReachability` below, which is about the machine that OWNS the chat;
  // the two are different hosts and this tile exists because of that.
  const servingHostId = useTabHostId();
  const servingReachability = useHostReachability(servingHostId);
  // The SAME reachability source the live dead-tile banner reads, so the two
  // surfaces can never describe one host two ways. Only the label is used here:
  // this tile is opened precisely because the owner is out of reach, and it
  // stays readable if that host returns (the row then offers the live tab).
  const ownerReachability = useHostReachability(node.ownerHostId);
  const identity = useMemo(
    () => ({
      taskId: node.taskId,
      chatId: node.chatId,
      ownerUserId: node.ownerUserId,
    }),
    [node.taskId, node.chatId, node.ownerUserId],
  );
  const state = useCloudChatTranscript({ client, identity, enabled: true });
  const publishedSource = useMemo(
    () => ({ identity, client }),
    [identity, client],
  );
  // The owning host's own name when the directory knows it, the raw id when it
  // does not. A host that has never been seen from this device is exactly the
  // case this surface exists for, so the id is a real fallback rather than a
  // defensive one.
  const ownerLabel =
    node.ownerHostId.length > 0
      ? ownerReachability.hostLabel
      : "another device";
  // Whether the machine that owns this chat is the one serving this copy.
  // Read off the ref rather than probed: `hostId` is the serving host this
  // tile is bound to for life and `ownerHostId` is the row's owner, so their
  // equality IS the question, settled at open and stable for the tab's life
  // (a later active-host swap cannot reach either field). Reached by the
  // canvas substituting a copy for a chat its own connected host answered
  // `CHAT_NOT_VISIBLE` for - see `ChatDeadTileBanner`'s
  // `chat-not-on-this-host`, whose banner this footer sits under.
  const ownerIsThisHost =
    node.ownerHostId.length > 0 && node.ownerHostId === node.hostId;
  // Whether this copy is the viewer's own chat, read off the ref like the
  // owner-host equality above. A collaborator's chat swaps the lock sentence
  // (and, in the child banner, the clone copy) for the foreign-owner arm -
  // the offline/back-soon vocabulary below is about the viewer's own fleet
  // and cannot be honestly said about a machine this account never sees.
  const ownedByViewer = useOwnedByViewer(node.ownerUserId);

  // The same Clone offer the LIVE tile's dead-tile banner makes, on the copy.
  // Gated (inside the child) on the SAME two signals the lock sentence below
  // reads - the owner's reachability and `ownerIsThisHost` - so the banner and
  // the sentence can never describe one host two ways.
  const deadTileBanner = (
    <PublishedChatDeadTileBanner
      node={node}
      epicId={props.epicId}
      tabId={props.viewTabId}
      ownerStatus={ownerReachability.status}
      ownerIsThisHost={ownerIsThisHost}
      ownerLabel={ownerLabel}
    />
  );

  // The one transition an on-demand read cannot cover: the owner came back
  // while this copy was open. Same reachability source the sidebar row's lock
  // reads - a second source could disagree with the row that opened this tile.
  // No "open it live" affordance, and no claim that the owner is back.
  // Licensing a live open needs PROOF that this copy is a local chat's live
  // lineage, and a published tile is only ever opened for a row that had no
  // such proof. Reachability alone was the approximation that produced a button
  // routing to a record-backed tile which opened nothing at all. Cross-host live
  // open is a real future capability - a tab bound to the OWNER host rendering
  // the owner's session - but it waits on distinct host identities (ticket 26)
  // and an owner-side presence answer rather than being guessed at from here.
  const conversion = useMemo(
    () =>
      state.kind === "ready" ? convertPublishedChat(state.presented) : null,
    [state],
  );
  const handle = useMemo(() => {
    if (state.kind !== "ready" || conversion === null) return null;
    const row = state.read.chat;
    // `ready` implies an `ok` read, and `ok` always carries the row - `chat`
    // is null only on the `missing` outcome, which lands in the refused
    // state. A violation falls through to the notice rather than rendering
    // a transcript with fabricated metadata.
    if (row === null) return null;
    return createPublishedChatSessionHandle({
      epicId: props.epicId,
      chatId: node.chatId,
      ownerUserId: node.ownerUserId,
      title: row.title ?? node.name,
      createdAt: row.createdAt,
      updatedAt: row.publishedAt ?? row.metadataUpdatedAt,
      conversion,
    });
  }, [
    state,
    conversion,
    props.epicId,
    node.chatId,
    node.ownerUserId,
    node.name,
  ]);

  // The doc-replica fallback: enabled ONLY once the cloud read has settled
  // `unpublished` - every other refusal (needs-newer-app, ambiguous-identity,
  // corrupt) keeps its own notice, unmasked.
  const cloudUnpublished =
    state.kind === "refused" && state.read.outcome.kind === "unpublished";
  const replicaQuery = useChatReplicaRead({
    client,
    epicId: props.epicId,
    chatId: node.chatId,
    enabled: cloudUnpublished,
  });
  const replicaOutcome = replicaQuery.data?.outcome;
  const replicaConversion = useMemo(
    () =>
      replicaOutcome?.status === "ok"
        ? convertReplicaChat(replicaOutcome.messages, replicaOutcome.events)
        : null,
    [replicaOutcome],
  );
  const replicaHandle = useMemo(() => {
    // Gated on `cloudUnpublished` explicitly, not just on the query having
    // data: a stale cache entry from an EARLIER unpublished read must not
    // render once the cloud read settles on a different refusal (or on
    // `ready`) - the "only then" in this branch's whole reason for existing.
    if (
      !cloudUnpublished ||
      replicaOutcome?.status !== "ok" ||
      replicaConversion === null
    ) {
      return null;
    }
    return createPublishedChatSessionHandle({
      epicId: props.epicId,
      chatId: node.chatId,
      ownerUserId: replicaOutcome.chat.userId,
      // No `?? node.name` fallback here unlike the published branch below:
      // this outcome's `title` comes straight off the doc record
      // (`ChatV200.title: z.string()`, never nullable), so a fallback would
      // be dead code the repo's `no-unnecessary-condition` rule would flag.
      title: replicaOutcome.chat.title,
      createdAt: replicaOutcome.chat.createdAt,
      updatedAt: replicaOutcome.chat.updatedAt,
      conversion: replicaConversion,
    });
  }, [
    cloudUnpublished,
    replicaOutcome,
    replicaConversion,
    props.epicId,
    node.chatId,
  ]);

  // Audit S3, at the surface the catalog names: this tile's reads go through
  // the TAB's client, and when that client is null every `useHostQuery` under
  // it disables itself, leaving `isPending` true, `data` undefined and `error`
  // null - forever. `useCloudChatTranscript` faithfully reports that as
  // `loading`, and the arm below rendered a spinner for it with no deadline
  // and no words. Bounded and named now, against the SERVING host (the one
  // whose client is null), which is not the owner host the banner talks about.
  //
  // The replica arm folds in here rather than keeping its own spinner. Its
  // original reason survives and still holds: while the replica read is in
  // flight the "not published yet" notice below would flash for content that
  // turns out to exist, so this must win over that branch - it just no longer
  // wins by spinning indefinitely.
  const boundedLoad = useBoundedHostLoad({
    hostId: servingHostId,
    hostLabel: resolvedHostLabel(servingReachability),
    pending:
      state.kind === "loading" || (cloudUnpublished && replicaQuery.isPending),
  });

  if (boundedLoad.kind !== "ready") {
    return (
      <div className="flex h-full min-h-0 flex-col" data-node-id={node.id}>
        <TileHostLoadState
          load={boundedLoad}
          subject="agent"
          onRetry={null}
          testId={`published-chat-tile-load-${node.id}`}
        />
      </div>
    );
  }

  if (replicaHandle !== null && replicaConversion !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-node-id={node.id}>
        {deadTileBanner}
        <ChatTileSessionView
          handle={replicaHandle}
          node={{
            id: node.chatId,
            instanceId: node.instanceId,
            name: node.name,
          }}
          viewTabId={props.viewTabId}
          tileId={props.tileId}
          isActive={props.isActive}
          currentEpicId={props.epicId}
          readOnlyNotice={replicaChatLockReason({
            ownerIsReachable: ownerReachability.status === "reachable",
            ownerIsThisHost,
            ownedByViewer,
            ownerLabel,
            unreadableCount: replicaConversion.unreadableCount,
          })}
        />
      </div>
    );
  }

  const replicaFailure = replicaTransportFailure(
    cloudUnpublished,
    replicaQuery,
  );

  if (state.kind !== "ready" || handle === null || conversion === null) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-node-id={node.id}>
        <PublishedChatNotice
          state={
            replicaFailure === null
              ? state
              : { kind: "failed", error: replicaFailure }
          }
          ownerLabel={ownerLabel}
          refusal={
            state.kind === "refused"
              ? describeCloudChatRefusal(state.read.outcome)
              : null
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-node-id={node.id}>
      {deadTileBanner}
      {/* The heavy content this transcript NAMES - file diffs, full plans -
          is not in the published document; it is content-addressed in the
          cloud. The blocks that expand it decide their own fetch several
          layers down and are shared with every live chat, so this is the seam
          that redirects them without threading a source through renderers that
          have no business knowing about publication. Absent everywhere else. */}
      <PublishedChatSourceProvider source={publishedSource}>
        <ChatTileSessionView
          handle={handle}
          node={{
            // The CHAT id, not the tile ref's id: inside the surface this is what
            // per-chat UI state is keyed by, and it should name the same chat the
            // live tile would. The finer tile key exists to keep the two tiles
            // apart on the canvas, which is a different question.
            id: node.chatId,
            instanceId: node.instanceId,
            name: node.name,
          }}
          viewTabId={props.viewTabId}
          tileId={props.tileId}
          isActive={props.isActive}
          currentEpicId={props.epicId}
          readOnlyNotice={publishedChatLockReason({
            ownerIsReachable: ownerReachability.status === "reachable",
            ownerIsThisHost,
            ownedByViewer,
            ownerLabel,
            unreadableCount: conversion.unreadableCount,
            fidelityNotice: state.fidelityNotice,
            publishedAt: publishedCopyStamp(state.read),
          })}
        />
      </PublishedChatSourceProvider>
    </div>
  );
}

/**
 * When the copy on screen was published, off the row the transcript read
 * returned rather than any later cloud state - the reader's question is about
 * the bytes in front of them. `null` on a row published by a build that
 * predates the stamp.
 */
function publishedCopyStamp(read: CloudChatRead): number | null {
  return read.chat?.publishedAt ?? null;
}

/**
 * The clone banner an unreachable owner earns on the copy, or nothing.
 *
 * Reachable owner: the row offers the live tab, no clone needed. Owner IS the
 * serving host: that is the canvas substitution arm, whose banner
 * `tab-group-view` already mounts above this tile - a second one here would
 * double it. The ref carries the owner (`ownerUserId`), so it is threaded
 * through rather than re-resolved from the cloud list, which a post-restart
 * host with swept registry facts cannot answer.
 */
function PublishedChatDeadTileBanner(props: {
  readonly node: PublishedChatTileRef;
  readonly epicId: string;
  readonly tabId: string;
  readonly ownerStatus: HostReachabilityStatus;
  readonly ownerIsThisHost: boolean;
  readonly ownerLabel: string;
}): ReactNode {
  if (props.ownerStatus !== "unreachable" || props.ownerIsThisHost) {
    return null;
  }
  return (
    <ChatDeadTileBannerContainer
      epicId={props.epicId}
      tabId={props.tabId}
      chatId={props.node.chatId}
      sourceHostId={props.node.ownerHostId}
      hostLabel={props.ownerLabel}
      reason="host-offline"
      showsPublishedCopy
      testId={`published-chat-dead-tile-${props.node.chatId}`}
      sourceOwnerUserId={props.node.ownerUserId}
    />
  );
}

/**
 * The replica read's TRANSPORT failure, or `null`.
 *
 * A replica read that failed is not a replica that is ABSENT, and from the
 * notice branch the two are otherwise identical: retries exhausted, `data` still
 * undefined. Rendering the cloud's `unpublished` refusal there tells the reader
 * nothing was ever published when in fact the lookup never completed, and offers
 * no way to try again.
 *
 * An older serving host is the one case where that refusal stays honest: it has
 * no replica RPC at all, so nothing failed - there is simply no second source.
 */
function replicaTransportFailure(
  cloudUnpublished: boolean,
  query: UseQueryResult<ChatReplicaReadResponse, HostRpcError>,
): HostRpcError | null {
  if (!cloudUnpublished || !query.isError) return null;
  return isCloudChatsUnsupported(query.error) ? null : query.error;
}
