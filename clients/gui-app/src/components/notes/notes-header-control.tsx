import { useState } from "react";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { NotesButton } from "@/components/notes/notes-button";
import { NotesDialog } from "@/components/notes/notes-dialog";

export function NotesHeaderControl() {
  const hostId = useAddressableHostId();
  const [open, setOpen] = useState(false);
  return (
    <>
      <NotesButton
        disabled={hostId === null}
        active={open}
        onClick={() => {
          setOpen(true);
        }}
      />
      <NotesDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
