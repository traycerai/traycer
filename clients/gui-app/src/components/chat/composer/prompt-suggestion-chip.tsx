import { useState, type ReactNode } from "react";
import { Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { ChatComposerBannerPortal } from "./chat-composer-banner-portal";

interface ComposerPromptSuggestionProps {
  /** The host's `suggestedPrompt`; `undefined` draws nothing. */
  readonly suggestedPrompt: string | undefined;
  /** `promptSuggestionChipAllowed` (`./prompt-suggestion`). */
  readonly allowed: boolean;
  /** Fills and focuses the composer. Must never send. */
  readonly onFill: (suggestion: string) => void;
}

/**
 * The provider's predicted next prompt as one dismissible chip in the
 * composer's banner portal (`chat.subscribe@1.17`).
 *
 * Click fills the composer with the text and focuses it - it NEVER sends; the
 * user still presses Enter. Absence draws nothing, and the host owns the
 * value's life: it clears it on any send or run opening, and a reconnect
 * restores it from the snapshot.
 *
 * Dismissal is keyed by the TEXT and held here, not in the store: dismissing
 * hides this suggestion, and a different one the provider offers after the
 * next turn shows again.
 */
export function ComposerPromptSuggestion(
  props: ComposerPromptSuggestionProps,
): ReactNode {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const suggestion = props.suggestedPrompt;
  if (!props.allowed || suggestion === undefined || suggestion === dismissed) {
    return null;
  }
  return (
    <ChatComposerBannerPortal>
      <div className="pointer-events-none px-4">
        <div className="pointer-events-auto mx-auto w-full max-w-3xl bg-canvas pt-4">
          <PromptSuggestionChip
            suggestion={suggestion}
            onFill={props.onFill}
            onDismiss={setDismissed}
          />
        </div>
      </div>
    </ChatComposerBannerPortal>
  );
}

interface PromptSuggestionChipProps {
  readonly suggestion: string;
  readonly onFill: (suggestion: string) => void;
  readonly onDismiss: (suggestion: string) => void;
}

export function PromptSuggestionChip(
  props: PromptSuggestionChipProps,
): ReactNode {
  const { suggestion } = props;
  return (
    <div
      role="group"
      aria-label="Suggested prompt"
      className="flex w-full min-w-0 items-center gap-1"
    >
      {/* The full text on hover, since the chip truncates it. Plain text,
          model-authored: rendered as text, never as markdown. */}
      <TooltipWrapper
        label={suggestion}
        side="top"
        sideOffset={undefined}
        align="start"
      >
        <Button
          type="button"
          variant="muted-outline"
          size="sm"
          className="min-w-0 max-w-full"
          aria-label={`Use suggested prompt: ${suggestion}`}
          onClick={() => props.onFill(suggestion)}
        >
          <Sparkles aria-hidden data-icon="inline-start" />
          <span className="min-w-0 truncate">{suggestion}</span>
        </Button>
      </TooltipWrapper>
      <Button
        type="button"
        variant="muted"
        size="icon-xs"
        aria-label="Dismiss suggested prompt"
        onClick={() => props.onDismiss(suggestion)}
      >
        <X aria-hidden />
      </Button>
    </div>
  );
}
