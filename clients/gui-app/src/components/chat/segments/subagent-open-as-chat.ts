import { createContext, use, useCallback, useMemo, useState } from "react";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  subagentCardName,
  subagentCardPath,
  subagentOwnedBackgroundItemCount,
} from "@/components/chat/segments/subagent-display";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

/**
 * Opens one subagent card's conversation as a full-height, read-only view
 * inside the SAME chat tile (`SubagentChatView`), with a breadcrumb back. A
 * transient drill-in, not a tile: the canvas tile tree is persisted and this
 * view need not survive a reload.
 */
export type OpenSubagentAsChat = (subagentId: string) => void;

export const OpenSubagentAsChatContext =
  createContext<OpenSubagentAsChat | null>(null);

/**
 * The transcript's opener, or `null` outside a transcript (an isolated render,
 * a test) - the card then draws no open-as-chat control.
 */
export function useOpenSubagentAsChat(): OpenSubagentAsChat | null {
  return use(OpenSubagentAsChatContext);
}

/**
 * The open-as-chat control drawn on the card with this id under `root` - where
 * focus returns when the reader steps back out of that card. Compares the
 * dataset value rather than interpolating the id into a selector: card ids are
 * persisted block ids behind a plain `string`, and jsdom has no `CSS.escape`.
 */
export function queryOpenAsChatControl(
  root: ParentNode,
  cardId: string,
): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(
    "[data-subagent-open-as-chat]",
  )) {
    if (element.dataset.subagentOpenAsChat === cardId) return element;
  }
  return null;
}

export interface SubagentDrillIn {
  /** The card whose conversation is open, or `null` for the transcript. */
  readonly openId: string | null;
  readonly open: OpenSubagentAsChat;
  readonly close: () => void;
}

/**
 * The chat tile's open-as-chat state: which card's conversation covers the
 * transcript, if any. Component state on purpose - a drill-in is transient
 * and belongs to this mount, never to the persisted tile tree. Held by the
 * tile rather than the transcript because the lower dock reads it too.
 *
 * It still ends with the transcript: `transcriptLoaded` going false closes it,
 * as unmounting the transcript did while the state lived there. A view left
 * open across a reload would mount already open when the snapshot returns,
 * and take focus on a reconnect nobody asked for.
 */
export function useSubagentDrillIn(transcriptLoaded: boolean): SubagentDrillIn {
  const [openId, setOpenId] = useState<string | null>(null);
  if (!transcriptLoaded && openId !== null) setOpenId(null);
  const open = useCallback<OpenSubagentAsChat>((subagentId) => {
    setOpenId(subagentId);
  }, []);
  const close = useCallback(() => {
    setOpenId(null);
  }, []);
  return useMemo(() => ({ openId, open, close }), [close, open, openId]);
}

/**
 * What the lower dock says while a subagent's conversation is open, in place
 * of the parent chat's composer and dock.
 */
export interface SubagentDockView {
  /** The open card's name; `null` once it left the loaded transcript. */
  readonly name: string | null;
  /** Background work the open subagent started that is still running. */
  readonly runningCount: number;
  readonly close: () => void;
}

/**
 * The dock's view of the drill-in, or `null` while the transcript is showing.
 *
 * Built from values rather than from the card: the card is a new object on
 * every streamed token, and the dock must not re-render on each one.
 */
export function useSubagentDockView(
  drillIn: SubagentDrillIn,
  messages: ReadonlyArray<ChatMessageModel>,
  backgroundItems: ReadonlyArray<BackgroundItem> | undefined,
): SubagentDockView | null {
  const { close, openId } = drillIn;
  const card = useMemo(
    () =>
      openId === null
        ? null
        : (subagentCardPath(messages, openId)?.at(-1) ?? null),
    [messages, openId],
  );
  const name = card === null ? null : subagentCardName(card);
  const runningCount = useMemo(
    () =>
      card === null || backgroundItems === undefined
        ? 0
        : subagentOwnedBackgroundItemCount(card, backgroundItems),
    [backgroundItems, card],
  );
  return useMemo(
    () => (openId === null ? null : { name, runningCount, close }),
    [close, name, openId, runningCount],
  );
}
