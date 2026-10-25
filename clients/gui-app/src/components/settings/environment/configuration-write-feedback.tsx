import type { ConfigurationWriteIssue } from "./configuration-write-issue";
import type { ReactNode } from "react";
import { ConfigurationConflict } from "./configuration-conflict";

export function ConfigurationWriteFeedback(props: {
  readonly issue: ConfigurationWriteIssue;
}): ReactNode {
  if (props.issue === null) return null;
  if (props.issue.kind === "conflict")
    return <ConfigurationConflict changedBy={props.issue.changedBy} />;
  return (
    <p role="status" className="text-ui-sm text-muted-foreground">
      {props.issue.kind === "refused"
        ? props.issue.line
        : "You no longer have access to change these settings."}
    </p>
  );
}
