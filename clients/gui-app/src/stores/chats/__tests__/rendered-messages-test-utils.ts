import { useMemo } from "react";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  createRenderedMessagesProjector,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";

/**
 * `renderHook` adapter over the real per-instance projector, for integration
 * tests that re-render with changing inputs. It owns no derivation.
 */
export function useRenderedMessages(
  input: RenderedMessagesInput,
  displayContext: RenderedMessagesDisplayContext,
): ReadonlyArray<ChatMessageModel> {
  const project = useMemo(() => createRenderedMessagesProjector(), []);
  return project(input, displayContext);
}
