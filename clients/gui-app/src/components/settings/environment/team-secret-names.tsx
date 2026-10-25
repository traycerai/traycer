import type { ReactNode } from "react";

/** Viewers see names and whether they are set, with no credential actions. */
export function TeamSecretNames(props: {
  readonly secrets: readonly {
    readonly name: string;
    readonly revoked: boolean;
  }[];
}): ReactNode {
  return (
    <section className="flex flex-col gap-3" aria-label="Secrets">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-ui-sm font-medium">Secrets</h2>
        <span className="text-ui-xs text-muted-foreground">
          Editors can replace these
        </span>
      </div>
      <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
        {props.secrets.map((secret) => (
          <li key={secret.name} className="flex flex-col gap-1 p-3">
            <span className="font-mono text-ui-sm">{secret.name}</span>
            <span className="text-ui-xs text-muted-foreground">
              {secret.revoked ? "Removing · no longer usable" : "Set"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
