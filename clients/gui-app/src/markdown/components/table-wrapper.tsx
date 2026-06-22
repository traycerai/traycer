import { cn } from "@/lib/utils";
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react";

interface TableProps {
  children?: ReactNode;
  node?: unknown;
  [key: string]: unknown;
}

const TABLE_WRAP_STYLE: CSSProperties = {
  margin: "0.75rem 0",
  overflowX: "auto",
  borderRadius: "0.375rem",
  border: "1px solid var(--traycer-code-border, rgba(127,127,127,0.3))",
};

const TABLE_STYLE: CSSProperties = {
  minWidth: "480px",
  width: "100%",
  borderCollapse: "collapse",
};

const TABLE_HEAD_STYLE: CSSProperties = {
  background: "var(--traycer-code-header-bg, rgba(127,127,127,0.1))",
};

const TABLE_HEADER_BASE_STYLE: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 10,
  borderBottom: "1px solid var(--traycer-code-border, rgba(127,127,127,0.3))",
  borderRight: "1px solid var(--traycer-code-border, rgba(127,127,127,0.3))",
  background: "var(--traycer-code-header-bg, rgba(127,127,127,0.1))",
  padding: "0.5rem 0.75rem",
  fontSize: "0.75rem",
  fontWeight: 600,
};

const TABLE_CELL_BASE_STYLE: CSSProperties = {
  borderTop: "1px solid var(--traycer-code-border, rgba(127,127,127,0.3))",
  borderRight: "1px solid var(--traycer-code-border, rgba(127,127,127,0.3))",
  padding: "0.5rem 0.75rem",
};

export function TableWrapper({ children }: TableProps) {
  return (
    <div className="traycer-md-table-wrap" style={TABLE_WRAP_STYLE}>
      <table style={TABLE_STYLE}>{children}</table>
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
  return <thead style={TABLE_HEAD_STYLE}>{children}</thead>;
}

type TextAlign = "center" | "right" | "left" | undefined;

function resolveHeaderAlign(align: string | undefined): TextAlign {
  if (align === "center") return "center";
  if (align === "right") return "right";
  return "left";
}

function resolveCellAlign(align: string | undefined): TextAlign {
  if (align === "center") return "center";
  if (align === "right") return "right";
  if (align === "left") return "left";
  return undefined;
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
      className={cn("traycer-md-th", className)}
      style={{
        ...TABLE_HEADER_BASE_STYLE,
        textAlign: resolveHeaderAlign(align),
      }}
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
      className={cn("traycer-md-td", className)}
      style={{
        ...TABLE_CELL_BASE_STYLE,
        textAlign: resolveCellAlign(align),
      }}
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
