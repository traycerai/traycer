import { useState } from "react";
import { HostDoctorCard } from "@/components/settings/panels/host-doctor-card";
import {
  INITIAL_RECURRENCE_STATE,
  type RecurrenceState,
} from "@/components/settings/panels/host-doctor-recurrence";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { IHostManagement } from "@traycer-clients/shared/platform/runner-host";

interface DoctorSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly management: IHostManagement;
}

export function DoctorSheet(props: DoctorSheetProps) {
  const { open, onOpenChange } = props;
  const [recurrence, setRecurrence] = useState<RecurrenceState>(
    INITIAL_RECURRENCE_STATE,
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl" showCloseButton>
        <SheetHeader>
          <SheetTitle>Host doctor</SheetTitle>
          <SheetDescription>
            Diagnostics for the local host, with one-click fixes for common
            issues.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {open ? (
            <HostDoctorCard
              recurrenceState={recurrence}
              onRecurrenceChange={setRecurrence}
            />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
