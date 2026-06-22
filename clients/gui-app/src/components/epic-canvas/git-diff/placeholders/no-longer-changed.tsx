import { CheckIcon } from "lucide-react";

interface NoLongerChangedProps {
  readonly filePath: string;
  readonly stage: string;
}

export function NoLongerChanged(props: NoLongerChangedProps) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center">
      <CheckIcon className="size-12 text-muted-foreground" />
      <h3 className="text-base font-semibold">No Longer Changed</h3>
      <p className="text-sm text-muted-foreground">
        {props.filePath} ({props.stage}) is no longer in the working directory
        changes.
      </p>
    </div>
  );
}
