import { useState } from "react";
import {
  ConfirmDestructiveDialog,
  type ConfirmDestructiveDialogProps,
} from "@/components/ui/confirm-destructive-dialog";

/** The dialog stays mounted after its first open so Radix can animate close. */
export function LazySidebarConfirmDialog(props: ConfirmDestructiveDialogProps) {
  const [hasOpened, setHasOpened] = useState(props.open);
  if (props.open && !hasOpened) setHasOpened(true);
  if (!props.open && !hasOpened) return null;
  return <ConfirmDestructiveDialog {...props} />;
}
