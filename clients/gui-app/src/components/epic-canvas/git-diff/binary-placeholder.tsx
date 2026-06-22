import { FileQuestionMarkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";

interface BinaryPlaceholderProps {
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly onOpenExternally: () => void;
  readonly openExternallyOpening: boolean;
}

export function BinaryPlaceholder(props: BinaryPlaceholderProps) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-8">
      <FileQuestionMarkIcon className="size-12 text-muted-foreground" />
      <h3 className="text-base font-semibold">Binary File</h3>
      <p className="text-sm text-muted-foreground">{props.fileName}</p>
      <p className="text-xs text-muted-foreground">
        {props.sizeBytes.toLocaleString()} bytes
      </p>
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
    </div>
  );
}
