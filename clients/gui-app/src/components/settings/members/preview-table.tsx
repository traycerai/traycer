import type { ReactNode } from "react";

export interface PreviewTableRow {
  readonly label: string;
  readonly value: string;
}

export function PreviewTable(props: {
  readonly rows: readonly PreviewTableRow[];
  readonly testId: string;
}): ReactNode {
  return (
    <table className="w-full text-left text-ui-sm" data-testid={props.testId}>
      <tbody>
        {props.rows.map((row) => (
          <tr key={row.label} className="align-top">
            <th className="w-[32%] py-1.5 pr-3 font-medium text-muted-foreground">
              {row.label}
            </th>
            <td className="py-1.5">{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
