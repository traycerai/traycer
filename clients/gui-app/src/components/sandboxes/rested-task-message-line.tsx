import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useRestedTaskMessageLine } from "@/hooks/sandboxes/use-rested-task-message-line";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { useStoppedSandboxSendReceiptStore } from "@/stores/sandboxes/stopped-sandbox-send-receipt-store";

export function RestedTaskMessageLine(props: {
  readonly epicId: string;
  readonly tabId: string;
}): ReactNode {
  const { epicId, tabId } = props;
  const line = useRestedTaskMessageLine(epicId);
  // A person's Stop or Cancel has its own line for the same message.
  const toldByGesture = useStoppedSandboxSendReceiptStore((state) =>
    Object.values(state.receipts).some(
      (receipt) =>
        receipt.epicId === epicId &&
        receipt.returned.kind === "task" &&
        (receipt.kind === "stopped" || receipt.kind === "cancelled"),
    ),
  );
  if (line === null || toldByGesture) return null;
  return (
    <div
      className="flex w-full flex-col gap-2 px-4 py-3 text-ui-xs"
      data-testid="rested-task-message-line"
    >
      <span>{line}</span>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="link"
          size="inline-xs"
          onClick={() => {
            useNewConversationModalOpenStore.getState().open({
              epicId,
              tabId,
              placement: null,
              parentId: null,
              // Unnamed: a named host stages nothing.
              hostId: null,
            });
          }}
        >
          Add agent
        </Button>
      </div>
    </div>
  );
}
