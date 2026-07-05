import { EditDraftPill } from "@/components/chat/composer/edit-draft-pill";

interface QueueEditDraftPillProps {
  readonly editingQueueItemId: string | null;
  readonly onCancel: (() => void) | null;
}

export function QueueEditDraftPill(props: QueueEditDraftPillProps) {
  if (props.editingQueueItemId === null || props.onCancel === null) {
    return null;
  }
  return (
    <EditDraftPill
      label="Editing"
      cancelAriaLabel="Cancel queued message editing"
      onCancel={props.onCancel}
      testId="queue-edit-draft-pill"
    />
  );
}
