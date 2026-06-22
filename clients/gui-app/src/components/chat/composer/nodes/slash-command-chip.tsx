import { memo } from "react";

function SlashCommandChipBase({ name }: { name: string }) {
  return (
    <span
      className="mx-0.5 inline-flex items-center rounded-md border border-border/70 bg-muted px-1.5 py-0.5 align-baseline font-mono text-[0.85em] text-foreground"
      data-composer-chip="slash-command"
    >
      {name}
    </span>
  );
}

export const SlashCommandChip = memo(SlashCommandChipBase);
