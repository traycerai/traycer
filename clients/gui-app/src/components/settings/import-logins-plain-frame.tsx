import type { ReactNode } from "react";

/**
 * The plain elements an `ImportLoginsFlow` step's chrome renders as on a
 * surface with no dialog: a heading, a paragraph and a right-aligned row.
 * Assembled into a frame by `PLAIN_IMPORT_LOGINS_FRAME`; this file exports
 * components only (fast refresh).
 */

export function PlainImportLoginsHeader(props: {
  readonly children: ReactNode;
}): ReactNode {
  return <div className="flex flex-col gap-1.5">{props.children}</div>;
}

export function PlainImportLoginsTitle(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <h2 className="text-ui-base leading-tight font-medium text-foreground">
      {props.children}
    </h2>
  );
}

export function PlainImportLoginsDescription(props: {
  readonly children: ReactNode;
}): ReactNode {
  return <p className="text-ui-sm text-muted-foreground">{props.children}</p>;
}

export function PlainImportLoginsFooter(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {props.children}
    </div>
  );
}
