import { useCallback, useMemo, type ReactNode } from "react";
import type { PublishedChatTileRef } from "@/stores/epics/canvas/types";
import { useHostClient } from "@/lib/host/runtime";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useCloudChatTranscript } from "@/hooks/chats/use-cloud-chat-transcript";
import { describeCloudChatRefusal } from "@/lib/chats/cloud-chat-refusal";
import {
  convertPublishedChat,
  createPublishedChatSessionHandle,
} from "@/lib/chats/published-chat-session";
import { ChatTileSessionView } from "./chat-tile";
import { ChatTileLoading } from "./chat-tile-runtime-gate";
import { PublishedChatNotice } from "./published-chat-notice";
import { PublishedChatOwnerBackBanner } from "./dead-tile-banner";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { v4 as uuidv4 } from "uuid";

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
 * The tile reads through `useHostClient()` - the app's own reachable host -
 * because the cloud read is a byte pipe: any host the device can reach serves
 * it, which is exactly what makes an offline owner readable. Nothing here binds
 * the OWNING host, so the tab-host-for-life rule is not bent; the owner is row
 * metadata that the notice names and nothing addresses.
 */

export interface PublishedChatTileProps {
  readonly node: PublishedChatTileRef;
  readonly viewTabId: string;
  readonly isActive: boolean;
  readonly epicId: string;
}

export function PublishedChatTile(props: PublishedChatTileProps): ReactNode {
  const { node } = props;
  const client = useHostClient();
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
  // The owning host's own name when the directory knows it, the raw id when it
  // does not. A host that has never been seen from this device is exactly the
  // case this surface exists for, so the id is a real fallback rather than a
  // defensive one.
  const ownerLabel =
    node.ownerHostId.length > 0 ? ownerReachability.hostLabel : "another device";

  // The one transition an on-demand read cannot cover: the owner came back
  // while this copy was open. Same reachability source the sidebar row's lock
  // reads - a second source could disagree with the row that opened this tile.
  const ownerIsBack =
    node.ownerHostId.length > 0 && ownerReachability.status === "reachable";
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );
  const openLive = useCallback(() => {
    // The ordinary open path, and the ordinary binding rule with it: the live
    // tab binds the OWNING host at open, because that is the host that can
    // actually answer for this chat.
    navigateNested(props.epicId, props.viewTabId, () =>
      prepareOpenTileInTabFocusTarget(props.viewTabId, {
        id: node.chatId,
        instanceId: uuidv4(),
        type: "chat",
        name: node.name,
        hostId: node.ownerHostId,
      }),
    );
  }, [
    navigateNested,
    prepareOpenTileInTabFocusTarget,
    props.epicId,
    props.viewTabId,
    node.chatId,
    node.name,
    node.ownerHostId,
  ]);
  const ownerBackBanner = ownerIsBack ? (
    <PublishedChatOwnerBackBanner
      hostLabel={ownerLabel}
      onOpenLive={openLive}
      testId={`published-chat-owner-back-${node.chatId}`}
    />
  ) : null;

  const conversion = useMemo(
    () => (state.kind === "ready" ? convertPublishedChat(state.presented) : null),
    [state],
  );
  const handle = useMemo(() => {
    if (state.kind !== "ready" || conversion === null) return null;
    const row = state.read.chat;
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

  if (state.kind === "loading") {
    return (
      <div className="flex h-full min-h-0 flex-col" data-node-id={node.id}>
        {ownerBackBanner}
        <ChatTileLoading />
      </div>
    );
  }

  if (state.kind !== "ready" || handle === null || conversion === null) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-node-id={node.id}>
        {ownerBackBanner}
        <PublishedChatNotice
          state={state}
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
      {ownerBackBanner}
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
        isActive={props.isActive}
        currentEpicId={props.epicId}
        readOnlyNotice={publishedChatLockReason({
          ownerLabel,
          unreadableCount: conversion.unreadableCount,
          fidelityNotice: state.fidelityNotice,
        })}
      />
    </div>
  );
}

/**
 * The locked composer's reason, in one sentence a reader can act on.
 *
 * It names three things because a reader needs all three to know what to do:
 * WHICH host owns the chat (so they know which machine to wake), that the host
 * is unreachable (so they do not read the lock as a permission problem), and
 * that this is the last published copy (so they do not assume they are seeing
 * a turn that finished after the host went away).
 *
 * A fidelity gap is appended rather than shown as a separate banner: it is the
 * same sentence's subject - what you are looking at - and a second notice
 * stacked above the composer would push the transcript around for something
 * that is not an error.
 */
export function publishedChatLockReason(input: {
  readonly ownerLabel: string;
  readonly unreadableCount: number;
  readonly fidelityNotice: string | null;
}): string {
  const base = `This agent lives on ${input.ownerLabel}, which is offline — showing the last published copy. Sending resumes when that host is back.`;
  if (input.unreadableCount > 0) {
    return `${base} ${input.unreadableCount} item${input.unreadableCount === 1 ? "" : "s"} need a newer version of Traycer to render.`;
  }
  if (input.fidelityNotice !== null) return `${base} ${input.fidelityNotice}`;
  return base;
}
