import { use } from "react";
import {
  ChatRestoreContext,
  type ChatRestoreContextValue,
} from "@/components/chat/chat-restore-context-core";

export function useChatRestoreContext(): ChatRestoreContextValue | null {
  return use(ChatRestoreContext);
}
