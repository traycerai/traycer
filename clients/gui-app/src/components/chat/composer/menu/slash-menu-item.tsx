import type { SlashCommand } from "@/lib/composer/types";

export interface SlashMenuItemProps {
  command: SlashCommand;
}

export function SlashMenuItem(props: SlashMenuItemProps) {
  const { command } = props;
  const argHint = command.argumentHint ?? "";
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 py-0.5">
      <span className="shrink-0 font-mono text-code text-foreground">
        /{command.name}
      </span>
      <span className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground/70">
        {command.description}
        {argHint.length > 0 ? (
          <span className="ml-1 font-mono text-code-xs">{argHint}</span>
        ) : null}
      </span>
      {command.kind === "skill" ? (
        <span className="shrink-0 rounded border border-border/70 px-1 py-px text-overline uppercase text-muted-foreground/70">
          Skill
        </span>
      ) : null}
    </div>
  );
}
