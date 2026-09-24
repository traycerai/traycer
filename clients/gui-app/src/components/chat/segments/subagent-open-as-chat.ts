import {
  createContext,
  use,
  useCallback,
  useMemo,
  useState,
} from "react";

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
