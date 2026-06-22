import type { MentionMenuEntry } from "@/lib/composer/mentions";

export type { MentionMenuEntry } from "@/lib/composer/mentions";

export interface MentionMenuItemProps {
  readonly entry: MentionMenuEntry;
}

export function MentionMenuItem(props: MentionMenuItemProps) {
  const { entry } = props;
  const trailing = entry.detail || entry.description;
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 py-0.5">
      <span className="shrink-0">{entry.icon}</span>
      <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">
        {entry.label}
      </span>
      {trailing ? (
        <span
          className="ml-auto min-w-0 shrink truncate text-ui-xs text-muted-foreground/70"
          title={trailing}
        >
          {trailing}
        </span>
      ) : null}
    </div>
  );
}
