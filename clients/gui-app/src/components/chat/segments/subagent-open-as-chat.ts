import { createContext, use, useCallback, useMemo, useState } from "react";

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
 * The transcript's open-as-chat state: which card's conversation covers the
 * transcript, if any. Component state on purpose - a drill-in is transient
 * and belongs to this mount, never to the persisted tile tree.
 */
export function useSubagentDrillIn(): SubagentDrillIn {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = useCallback<OpenSubagentAsChat>((subagentId) => {
    setOpenId(subagentId);
  }, []);
  const close = useCallback(() => {
    setOpenId(null);
  }, []);
  return useMemo(() => ({ openId, open, close }), [close, open, openId]);
}
