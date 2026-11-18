import { cn } from "@/lib/utils";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

interface TableProps {
  children?: ReactNode;
  node?: unknown;
  [key: string]: unknown;
}

/*
 * The chrome for all of these lives in `index.css` under the same class names,
 * which the elements already carried. Only the per-cell alignment is decided
 * here, because it comes from the markdown itself.
 */

export function TableWrapper({ children }: TableProps) {
  return (
    <div className="traycer-md-table-wrap">
      <table>{children}</table>
    </div>
  );
}

export function TableHead({
  children,
}: {
  children?: ReactNode;
  node?: unknown;
  [key: string]: unknown;
}) {
  return <thead>{children}</thead>;
}

/** A header with no alignment of its own reads left, as it did before. */
function resolveHeaderAlignClass(align: string | undefined): string {
  if (align === "center") return "text-center";
  if (align === "right") return "text-right";
  return "text-left";
}

/** A cell with no alignment inherits, so it gets no class at all. */
function resolveCellAlignClass(align: string | undefined): string | null {
  if (align === "center") return "text-center";
  if (align === "right") return "text-right";
  if (align === "left") return "text-left";
  return null;
}

type TableHeaderProps = ComponentPropsWithoutRef<"th"> & { node?: unknown };

export function TableHeader({
  children,
  className,
  align,
  node: _node,
  ...restProps
}: TableHeaderProps) {
  return (
    <th
      {...restProps}
      className={cn("traycer-md-th", resolveHeaderAlignClass(align), className)}
    >
      {children}
    </th>
  );
}

type TableCellProps = ComponentPropsWithoutRef<"td"> & { node?: unknown };

export function TableCell({
  children,
  className,
  align,
  node: _node,
  ...restProps
}: TableCellProps) {
  return (
    <td
      {...restProps}
      className={cn("traycer-md-td", resolveCellAlignClass(align), className)}
    >
      {children}
    </td>
  );
}

export function TableRow({
  children,
}: {
  children?: ReactNode;
  node?: unknown;
  [key: string]: unknown;
}) {
  return <tr className="traycer-md-tr">{children}</tr>;
}
