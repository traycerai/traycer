import { useRef, type ReactNode } from "react";
import {
  DraftRowBody,
  DraftRowTrailing,
} from "@/components/composer/drafts/draft-row";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDraftInventory } from "@/hooks/drafts/use-draft-inventory";
import { useDraftInventoryActions } from "@/hooks/drafts/use-draft-inventory-actions";
import {
  draftRowSourceChip,
  type DraftInventoryRow,
} from "@/lib/drafts/draft-inventory";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { useRelativeTimestamp } from "@/lib/relative-time";

/** Mounted only while open, keeping keystroke subscriptions out of app chrome. */
export function DraftsDialog(props: {
  readonly hostId: string | null;
  readonly onClose: () => void;
}): ReactNode {
  const rows = useDraftInventory(
    { surface: "landing", activeDraftId: null },
    "all",
  );
  const actions = useDraftInventoryActions(props.hostId);
  const openingRow = useRef(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[80dvh] flex-col overflow-hidden sm:max-w-2xl"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          if (openingRow.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Drafts</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          {rows.length === 0 ? (
            <p className="py-6 text-center text-ui-sm text-muted-foreground">
              No drafts yet
            </p>
          ) : (
            <ul className="flex flex-col">
              {rows.map((row) => (
                <DialogDraftRow
                  key={row.id}
                  row={row}
                  onOpen={() => {
                    openingRow.current = true;
                    useNewConversationModalOpenStore.getState().close();
                    props.onClose();
                    actions.openRow(row);
                  }}
                  onCopy={() => actions.copyRow(row)}
                  onDelete={() => actions.deleteRow(row)}
                />
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DialogDraftRow(props: {
  readonly row: DraftInventoryRow;
  readonly onOpen: () => void;
  readonly onCopy: () => void;
  readonly onDelete: () => void;
}) {
  const { row, onOpen, onCopy, onDelete } = props;
  const relative = useRelativeTimestamp(row.lastTouchedAt);
  return (
    <li className="relative rounded-md">
      <button
        type="button"
        aria-label={`Open draft: ${row.preview}`}
        onClick={onOpen}
        className="absolute inset-0 rounded-md hover:bg-foreground/5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="pointer-events-none relative flex min-w-0 flex-col gap-0.5 px-3 py-2">
        <DraftRowBody
          row={row}
          sourceChip={draftRowSourceChip(row, null, "all")}
          trailing={
            <DraftRowTrailing
              mobile
              relative={relative}
              onOpen={onOpen}
              onCopy={onCopy}
              onDelete={onDelete}
            />
          }
        />
      </div>
    </li>
  );
}
