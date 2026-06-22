import type { ToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";
import { SegmentPanel } from "./segment-panel";

/**
 * Renders a precomputed `ToolInputDetail` (the host-side structured tool
 * input) as a `$ command` line or a clean label/value list - never raw JSON.
 * Shared by the tool-call card and the resolved-approval card so both read the
 * same persisted shape. The raw harness input is no longer stored.
 */
export function ToolInputPanel({
  detail,
}: {
  readonly detail: ToolInputDetail;
}) {
  if (detail.kind === "command") {
    return (
      <SegmentPanel
        label="Input"
        copyValue={detail.command}
        tone="default"
        bodyChrome="framed"
        className={undefined}
      >
        <pre className="m-0 px-3 py-2 font-mono text-code-sm whitespace-pre-wrap text-foreground/90">
          <span className="text-muted-foreground">$ </span>
          {detail.command}
        </pre>
      </SegmentPanel>
    );
  }
  return (
    <SegmentPanel
      label="Input"
      copyValue={null}
      tone="default"
      bodyChrome="framed"
      className={undefined}
    >
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 py-2">
        {detail.entries.map((entry) => (
          // Keyed on the raw input key (unique), since distinct keys can
          // prettify to the same `label` (e.g. `output_mode` / `outputMode`).
          <div key={entry.key} className="contents">
            <dt className="font-mono text-code-sm text-muted-foreground">
              {entry.label}
            </dt>
            <dd className="m-0 min-w-0 font-mono text-code-sm whitespace-pre-wrap break-words text-foreground/90">
              {entry.value}
            </dd>
          </div>
        ))}
      </dl>
    </SegmentPanel>
  );
}
