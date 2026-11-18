import { ArrowLeftRight } from "lucide-react";

import type { ComposerMode } from "@/components/home/data/landing-options";

interface ComposerModeSwitcherProps {
  readonly composerMode: ComposerMode;
  readonly disabled: boolean;
  readonly onSwitch: () => void;
}

/** Shared Chat/Terminal switch so every new-agent surface stays identical. */
export function ComposerModeSwitcher(props: ComposerModeSwitcherProps) {
  const { composerMode, disabled, onSwitch } = props;
  const nextInterface = composerMode === "chat" ? "Terminal" : "Chat";

  return (
    <button
      type="button"
      aria-label={`Switch to the ${nextInterface} interface`}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ui-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      disabled={disabled}
      onClick={onSwitch}
    >
      <ArrowLeftRight className="size-3 shrink-0" />
      Switch to {nextInterface}
    </button>
  );
}
