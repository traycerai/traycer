import type { SlashCommand } from "@/lib/composer/types";

import type { ComposerSlashTrigger } from "../picker/composer-picker-store";

export interface SlashMenuItemProps {
  command: SlashCommand;
  /** Echoes the character that opened the picker, so a `$` list reads as `$name`. */
  trigger: ComposerSlashTrigger;
}

export function SlashMenuItem(props: SlashMenuItemProps) {
  const { command, trigger } = props;
  const argHint = command.argumentHint ?? "";
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 py-0.5">
      <span className="shrink-0 font-mono text-code text-foreground">
        {trigger}
        {command.name}
      </span>
      <span className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground/70">
        {command.description}
        {argHint.length > 0 ? (
          <span className="ml-1 font-mono text-code-xs">{argHint}</span>
        ) : null}
      </span>
    </div>
  );
}
