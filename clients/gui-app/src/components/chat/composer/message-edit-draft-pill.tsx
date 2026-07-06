import { EditDraftPill } from "@/components/chat/composer/edit-draft-pill";

interface MessageEditDraftPillProps {
  readonly active: boolean;
  readonly onCancel: () => void;
}

/**
 * "Editing message" marker shown above the composer editor while the draft is
 * a persisted message loaded for editing (the message-edit sibling of
 * `QueueEditDraftPill`). Submitting replaces that message (trim + resubmit);
 * Cancel ends edit mode and keeps the text as a plain draft.
 */
export function MessageEditDraftPill(props: MessageEditDraftPillProps) {
  if (!props.active) return null;
  return (
    <EditDraftPill
      label="Editing message"
      cancelAriaLabel="Cancel message editing"
      onCancel={props.onCancel}
      testId="message-edit-draft-pill"
    />
  );
}
