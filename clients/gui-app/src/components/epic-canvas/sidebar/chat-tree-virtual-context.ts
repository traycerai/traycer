import { createContext, useContext } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { ChatTreeRowModel } from "@/components/epic-canvas/sidebar/chat-tree-rows";

export type ChatTreeVirtualizer = Virtualizer<HTMLDivElement, HTMLLIElement>;

export type ChatTreeScrollAlign = "auto" | "start" | "center" | "end";

/**
 * What the rendered chat tree exposes to the hooks that work on it: reveal,
 * focus, drag and scroll anchoring. Read with `useChatTreeVirtual`
 * from anything rendered inside the list, the effects seam included.
 */
export interface ChatTreeVirtualApi {
  readonly virtualizer: ChatTreeVirtualizer;
  /** The rows being drawn - after any presentation layer between model and list. */
  readonly model: ChatTreeRowModel;
  readonly scrollElement: () => HTMLDivElement | null;
  /** The tree region (type-to-filter, reveal lookups). */
  readonly regionElement: () => HTMLDivElement | null;
  /** The first row drawing `nodeId`, or -1. */
  readonly indexOfNodeId: (nodeId: string) => number;
  readonly scrollToIndex: (index: number, align: ChatTreeScrollAlign) => void;
  /** Changes exactly when the set of rendered rows changes. */
  readonly rangeVersion: string;
  /** Changes when any rendered row's offset or size changes. */
  readonly measureVersion: string;
}

export const ChatTreeVirtualContext = createContext<ChatTreeVirtualApi | null>(
  null,
);

export function useChatTreeVirtual(): ChatTreeVirtualApi {
  const api = useContext(ChatTreeVirtualContext);
  if (api === null) {
    throw new Error("useChatTreeVirtual is used outside ChatTreeVirtualList");
  }
  return api;
}
