import { createContext, use } from "react";
import type { OpencodeLine } from "@traycer/protocol/common/opencode-line";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { isOpencodeFamilyHarness } from "@/lib/chat/opencode-line";

/**
 * The OpenCode line of the chat a surface belongs to (`chatOpencodeLine`), so
 * its composer, picker and slash commands read that line's catalogs. `null`
 * outside a chat, and for a chat that has not run OpenCode yet: the host then
 * answers with the line a new chat would start on.
 */
export const ChatOpencodeLineContext = createContext<OpencodeLine | null>(null);

export function useChatOpencodeLine(): OpencodeLine | null {
  return use(ChatOpencodeLineContext);
}

/**
 * The `opencodeLine` key a catalog request for `harnessId` carries: the chat's
 * line for every harness that runs OpenCode, which reads its catalogs on that
 * line; nothing otherwise, so every other harness keeps its single cache slot.
 */
export function catalogOpencodeLineParam(
  harnessId: GuiHarnessId,
  line: OpencodeLine | null,
): { readonly opencodeLine?: OpencodeLine } {
  return isOpencodeFamilyHarness(harnessId) && line !== null
    ? { opencodeLine: line }
    : {};
}
