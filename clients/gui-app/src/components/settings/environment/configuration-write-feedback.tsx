import type { ConfigurationWriteIssue } from "./configuration-write-issue";
import type { ReactNode } from "react";
import { ConfigurationConflict } from "./configuration-conflict";
import { useCanEditConfiguration } from "./configuration-source";

/**
 * What became of the last write on this page. The access refusal belongs to
 * the moment of a stale write — the role changed under an open form — so once
 * the page has read the role that refused it, the page's own standing line
 * says what the reader can do and this stops repeating it. A refusal that
 * names its own reason always stands: nothing else says it.
 */
export function ConfigurationWriteFeedback(props: {
  readonly issue: ConfigurationWriteIssue;
}): ReactNode {
  const canEdit = useCanEditConfiguration();
  if (props.issue === null) return null;
  if (props.issue.kind === "conflict")
    return <ConfigurationConflict changedBy={props.issue.changedBy} />;
  if (props.issue.kind === "refused")
    return (
      <p role="status" className="text-ui-sm text-muted-foreground">
        {props.issue.line}
      </p>
    );
  if (!canEdit) return null;
  return (
    <p role="status" className="text-ui-sm text-muted-foreground">
      You no longer have access to change these settings.
    </p>
  );
}
