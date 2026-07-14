/**
 * Pure-CSS preview of the effective shell invocation, reusing the
 * `--term-ansi-*` palette so it tracks the active theme (mirrors the
 * Appearance panel's terminal preview). Shows exactly what every new terminal
 * launches. Whether the config is the synthesised system default is surfaced by
 * the picker's "System default" row, not repeated here.
 */
export function EffectiveCommandPreview(props: {
  readonly path: string;
  readonly args: readonly string[];
}) {
  const { path, args } = props;
  return (
    <div
      className="w-full overflow-hidden rounded-md border border-border bg-background font-mono text-code-sm text-foreground"
      aria-label="Effective shell command"
    >
      <div className="flex items-center gap-1.5 border-b border-border bg-muted px-3 py-1.5">
        <span className="size-2.5 rounded-full bg-[var(--term-ansi-red)]" />
        <span className="size-2.5 rounded-full bg-[var(--term-ansi-yellow)]" />
        <span className="size-2.5 rounded-full bg-[var(--term-ansi-green)]" />
        <span className="ml-2 text-ui-xs text-muted-foreground">
          effective command
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2.5 leading-snug">
        <span className="text-[var(--term-ansi-green)]">❯</span>
        <span className="text-[var(--term-ansi-cyan)]">{path}</span>
        {args.length > 0 ? <span>{args.join(" ")}</span> : null}
      </div>
    </div>
  );
}
