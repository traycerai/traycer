import { ArrowRight, Check, Copy } from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { cn } from "@/lib/utils";
import type { TraycerNextStepOption } from "@/markdown/traycer-next-steps";

export interface NextStepActionHandler {
  readonly canSend: boolean;
  readonly onSend: (option: TraycerNextStepOption) => boolean;
}

interface NextStepsActionGroupProps {
  readonly blockId: string;
  readonly options: ReadonlyArray<TraycerNextStepOption>;
  readonly complete: boolean;
  readonly locked: boolean;
  readonly actionHandler: NextStepActionHandler | null;
  readonly onLock: (blockId: string) => void;
}

const COPIED_RESET_MS = 1600;

const handleCopyError = (): void => {
  toast.error("Couldn't copy to clipboard.");
};

export function NextStepsActionGroup(props: NextStepsActionGroupProps) {
  const actionHandler = props.actionHandler;
  const disabled =
    !props.complete ||
    props.locked ||
    actionHandler === null ||
    !actionHandler.canSend;

  return (
    <div
      className={cn(
        "not-prose mt-2 flex flex-wrap items-center gap-2",
        props.locked && "opacity-70",
      )}
      data-testid="traycer-next-steps"
      data-next-steps-complete={props.complete ? "true" : "false"}
      data-quote-exclude=""
    >
      {props.options.map((option) => (
        <NextStepAction
          key={option.id}
          option={option}
          complete={props.complete}
          disabled={disabled}
          actionHandler={actionHandler}
          blockId={props.blockId}
          onLock={props.onLock}
        />
      ))}
    </div>
  );
}

interface NextStepActionProps {
  readonly option: TraycerNextStepOption;
  readonly complete: boolean;
  readonly disabled: boolean;
  readonly actionHandler: NextStepActionHandler | null;
  readonly blockId: string;
  readonly onLock: (blockId: string) => void;
}

function NextStepAction(props: NextStepActionProps) {
  const { option } = props;
  const { copied, copy } = useClipboardCopy({
    resetMs: COPIED_RESET_MS,
    onSuccess: null,
    onError: handleCopyError,
  });
  const handleCopy = useCallback(
    () => copy(option.prompt),
    [copy, option.prompt],
  );
  const copyLabel = copied ? "Copied" : `Copy next step: ${option.prompt}`;

  return (
    <div className="group/next-step relative inline-flex max-w-full">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-auto min-h-7 min-w-0 max-w-full shrink items-start justify-start whitespace-normal py-2 pr-10 pl-1 text-left"
        disabled={props.disabled}
        onClick={() => {
          if (props.actionHandler === null || props.disabled) return;
          if (props.actionHandler.onSend(option)) {
            props.onLock(props.blockId);
          }
        }}
      >
        <ArrowRight data-icon="inline-start" aria-hidden className="mt-0.5" />
        <span className="min-w-0 whitespace-normal wrap-break-word">
          {option.prompt}
        </span>
      </Button>
      <TooltipWrapper
        label={copied ? "Copied" : "Copy next step"}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="pointer-events-none absolute top-1/2 right-1.5 z-10 -translate-y-1/2 bg-muted/80 text-muted-foreground opacity-0 transition-opacity group-hover/next-step:pointer-events-auto group-hover/next-step:opacity-100 group-focus-within/next-step:pointer-events-auto group-focus-within/next-step:opacity-100 hover:bg-muted hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100"
          disabled={!props.complete}
          aria-label={copyLabel}
          onClick={handleCopy}
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <Copy className="size-3.5" aria-hidden />
          )}
        </Button>
      </TooltipWrapper>
    </div>
  );
}
