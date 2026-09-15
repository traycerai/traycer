import { AlertCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface TruncatedBannerProps {
  readonly truncatedAfterBytes: number;
  readonly onLoadFull: () => void;
}

export function TruncatedBanner(props: TruncatedBannerProps) {
  return (
    <div className="flex items-center gap-3 border-b bg-warning/10 px-4 py-3">
      <AlertCircleIcon className="size-5 flex-shrink-0 text-warning-foreground" />
      <div className="flex flex-1 flex-col gap-1">
        <p className="text-sm font-medium text-warning-foreground">
          Diff truncated after {props.truncatedAfterBytes.toLocaleString()}{" "}
          bytes
        </p>
      </div>
      <Button
        onClick={props.onLoadFull}
        variant="outline"
        size="sm"
        className="shrink-0"
      >
        Load Full
      </Button>
    </div>
  );
}
