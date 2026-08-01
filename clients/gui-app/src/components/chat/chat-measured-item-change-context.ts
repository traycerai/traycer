import {
  createContext,
  use,
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

export type RequestChatMeasuredItemChange = (
  anchorElement: HTMLElement | null,
  mutate: () => void,
) => void;
type ChatMeasuredOpenChange = (next: boolean) => void;

const noopRequestChatMeasuredItemChange: RequestChatMeasuredItemChange = (
  _anchorElement,
  mutate,
) => {
  // Segment tests render leaves outside ChatMessages; in the app this context
  // is provided by the chat list boundary (ChatMessages), where a request
  // preserves the toggle's own visual position via a flushSync + geometric
  // scroll correction (see chat-scroll-disclosure.ts).
  mutate();
};

export const ChatMeasuredItemChangeContext =
  createContext<RequestChatMeasuredItemChange>(
    noopRequestChatMeasuredItemChange,
  );

function useRequestChatMeasuredItemChange(): RequestChatMeasuredItemChange {
  return use(ChatMeasuredItemChangeContext);
}

/**
 * Wraps a `Collapsible`-style `onOpenChange` so toggling it also requests
 * scroll-position preservation. `anchorRef` should point at the row's own
 * trigger/anchor element (read at call time, not on every render) - the
 * element whose bottom edge should stay visually stationary across the
 * toggle.
 */
export function useChatMeasuredOpenChange(
  onOpenChange: ChatMeasuredOpenChange,
  anchorRef: RefObject<HTMLElement | null>,
): ChatMeasuredOpenChange {
  const requestMeasuredItemChange = useRequestChatMeasuredItemChange();
  return useCallback(
    (next: boolean) => {
      requestMeasuredItemChange(anchorRef.current, () => onOpenChange(next));
    },
    [anchorRef, onOpenChange, requestMeasuredItemChange],
  );
}

export function useChatMeasuredBooleanToggle(
  setValue: Dispatch<SetStateAction<boolean>>,
  anchorRef: RefObject<HTMLElement | null>,
): () => void {
  const requestMeasuredItemChange = useRequestChatMeasuredItemChange();
  return useCallback(() => {
    requestMeasuredItemChange(anchorRef.current, () =>
      setValue((current) => !current),
    );
  }, [anchorRef, requestMeasuredItemChange, setValue]);
}
