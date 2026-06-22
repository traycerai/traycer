import { AlertCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface TruncatedBannerProps {
  readonly truncatedAfterBytes: number;
  readonly onLoadFull: () => void;
}

export function TruncatedBanner(props: TruncatedBannerProps) {
  return (
    <div className="flex items-center gap-3 border-b bg-yellow-50 px-4 py-3 dark:bg-yellow-900/20">
      <AlertCircleIcon className="size-5 flex-shrink-0 text-yellow-600 dark:text-yellow-500" />
      <div className="flex flex-1 flex-col gap-1">
        <p className="text-sm font-medium text-yellow-900 dark:text-yellow-200">
          Diff truncated after {props.truncatedAfterBytes.toLocaleString()}{" "}
          bytes
        </p>
      </div>
      <Button
        onClick={props.onLoadFull}
        variant="outline"
        size="sm"
        className="flex-shrink-0"
      >
        Load Full
      </Button>
    </div>
  );
}
