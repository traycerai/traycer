import { Monitor } from "lucide-react";
import { formatSingleLine } from "@/lib/utils";

interface MonitorEventSegmentProps {
  readonly name: string;
}

export function MonitorEventSegment(props: MonitorEventSegmentProps) {
  const name = formatSingleLine(props.name, {
    maxLength: 80,
    ellipsis: "...",
  });

  return (
    <div className="text-ui-sm text-muted-foreground">
      <div className="flex max-w-full items-center gap-2 overflow-hidden py-1 pr-1 text-ui-sm text-muted-foreground">
        <Monitor className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate font-medium">
          Event received from monitor "{name}"
        </span>
      </div>
    </div>
  );
}
