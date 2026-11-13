import { useState, type ReactNode } from "react";
import {
  ConfirmDestructiveDialog,
  type ConfirmDestructiveDialogProps,
} from "@/components/ui/confirm-destructive-dialog";

/** The dialog stays mounted after its first open so Radix can animate close. */
export function SidebarDialogMount(props: {
  readonly open: boolean;
  readonly children: ReactNode;
}) {
  const [hasOpened, setHasOpened] = useState(props.open);
  if (props.open && !hasOpened) setHasOpened(true);
  if (!props.open && !hasOpened) return null;
  return props.children;
}

export function LazySidebarConfirmDialog(props: ConfirmDestructiveDialogProps) {
  return (
    <SidebarDialogMount open={props.open}>
      <ConfirmDestructiveDialog {...props} />
    </SidebarDialogMount>
  );
}
