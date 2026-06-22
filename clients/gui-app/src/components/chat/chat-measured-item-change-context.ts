import {
  createContext,
  use,
  useCallback,
  type Dispatch,
  type SetStateAction,
} from "react";

type RequestChatMeasuredItemChange = () => void;
type ChatMeasuredOpenChange = (next: boolean) => void;

const noopRequestChatMeasuredItemChange: RequestChatMeasuredItemChange = () => {
  // Segment tests render leaves outside ChatMessages; in the app this context
  // is provided by the chat list boundary (ChatMessages), where a request
  // re-pins the scroller to the bottom iff the reader is following the tail.
};

export const ChatMeasuredItemChangeContext =
  createContext<RequestChatMeasuredItemChange>(
    noopRequestChatMeasuredItemChange,
  );

function useRequestChatMeasuredItemChange(): RequestChatMeasuredItemChange {
  return use(ChatMeasuredItemChangeContext);
}

export function useChatMeasuredOpenChange(
  onOpenChange: ChatMeasuredOpenChange,
): ChatMeasuredOpenChange {
  const requestMeasuredItemChange = useRequestChatMeasuredItemChange();
  return useCallback(
    (next: boolean) => {
      onOpenChange(next);
      requestMeasuredItemChange();
    },
    [onOpenChange, requestMeasuredItemChange],
  );
}

export function useChatMeasuredBooleanToggle(
  setValue: Dispatch<SetStateAction<boolean>>,
): () => void {
  const requestMeasuredItemChange = useRequestChatMeasuredItemChange();
  return useCallback(() => {
    setValue((current) => !current);
    requestMeasuredItemChange();
  }, [requestMeasuredItemChange, setValue]);
}
