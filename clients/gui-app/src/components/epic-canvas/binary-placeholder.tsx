import { FileQuestionMarkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";

interface BinaryPlaceholderProps {
  readonly fileName: string;
  readonly sizeBytes: number | null;
  /** One-line reason shown below the size (image-preview decision log, decision #14). `null` renders none. */
  readonly reason: string | null;
  /** `null` when there is no single unambiguous file on disk to open (e.g. a per-side diff placeholder) - hides the button entirely rather than disabling it. */
  readonly onOpenExternally: (() => void) | null;
  readonly openExternallyOpening: boolean;
  /** Smaller icon/spacing, no heading, for a diff column rather than a full tile. */
  readonly compact: boolean;
}

export function BinaryPlaceholder(props: BinaryPlaceholderProps) {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col items-center justify-center text-center",
        props.compact ? "gap-2 p-4" : "gap-4 p-8",
      )}
    >
      <FileQuestionMarkIcon
        className={cn(
          "text-muted-foreground",
          props.compact ? "size-6" : "size-12",
        )}
      />
      {props.compact ? null : (
        <h3 className="text-base font-semibold">Binary File</h3>
      )}
      <p
        className={cn(
          "text-muted-foreground",
          props.compact ? "text-xs" : "text-sm",
        )}
      >
        {props.fileName}
      </p>
      {props.sizeBytes !== null ? (
        <p className="text-xs text-muted-foreground">
          {props.sizeBytes.toLocaleString()} bytes
        </p>
      ) : null}
      {props.reason !== null ? (
        <p className="text-xs text-muted-foreground">{props.reason}</p>
      ) : null}
      {props.onOpenExternally !== null ? (
        <Button
          onClick={props.onOpenExternally}
          variant="outline"
          size="sm"
          disabled={props.openExternallyOpening}
        >
          {props.openExternallyOpening ? (
            <AgentSpinningDots
              className="size-4"
              testId="binary-open-editor-spinner"
              variant={undefined}
            />
          ) : null}
          Open Externally
        </Button>
      ) : null}
    </div>
  );
}
