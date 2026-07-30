import { Component, type ErrorInfo, type ReactNode } from "react";
import { appLogger } from "@/lib/logger";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueDraftContext } from "@/lib/report-issue-draft-context";
import {
  captureReportIssueError,
  type ReportIssueErrorCapture,
} from "@/lib/report-issue-error-capture";

interface BlockErrorBoundaryProps {
  /** Headline shown in the fallback panel. */
  readonly title: string;
  /** Copy-source callback wired to the fallback's "Copy source" button. */
  readonly onCopy: () => void;
  readonly children: ReactNode;
}

interface BlockErrorBoundaryState {
  readonly error: Error | null;
  readonly capture: ReportIssueErrorCapture | null;
}

/**
 * NodeView-scoped error boundary. A crash in the mermaid renderer or the
 * wireframe iframe observer must not tear down the whole artifact editor
 * - users would lose the floating toolbar and every other block. We render
 * a recoverable fallback panel per-block and expose a retry so the user
 * can recover after fixing the source (e.g. re-opening the edit surface).
 *
 * The fallback is rendered by this component directly - passing a render
 * prop back from the NodeView would force us to define an inline fallback
 * component per render, which confuses React reconciliation (and the
 * `react/no-unstable-nested-components` lint rule). Keeping the fallback
 * shape fixed and driving it through primitive props works just as well
 * for the only two current callers.
 */
export class BlockErrorBoundary extends Component<
  BlockErrorBoundaryProps,
  BlockErrorBoundaryState
> {
  constructor(props: BlockErrorBoundaryProps) {
    super(props);
    this.state = { error: null, capture: null };
  }

  static getDerivedStateFromError(error: Error): BlockErrorBoundaryState {
    return { error, capture: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Captured here (catch time), not in render: mints the correlation id /
    // fingerprint once and reports to Sentry - re-deriving in render would
    // re-mint and re-capture on every re-render.
    const capture = captureReportIssueError({
      error,
      componentStack: info.componentStack ?? null,
      errorCode: null,
      sourceAction: "Artifact editor",
    });
    this.setState({ capture });
    appLogger.errorSummary(
      "[artifact-editor] block NodeView crashed",
      { componentStack: capture.cause.componentStack },
      error,
    );
  }

  private reset = (): void => {
    this.setState({ error: null, capture: null });
  };

  override render(): ReactNode {
    const { error, capture } = this.state;
    if (error === null) {
      return this.props.children;
    }
    return (
      <div className="tc-node-block__error" role="alert">
        <div className="tc-node-block__error-title">{this.props.title}</div>
        <div className="tc-node-block__error-detail">{error.message}</div>
        <div className="tc-node-block__error-actions">
          <button
            type="button"
            className="tc-editor-toolbar-button"
            onClick={this.props.onCopy}
          >
            Copy source
          </button>
          <button
            type="button"
            className="tc-editor-toolbar-button"
            onClick={this.reset}
          >
            Retry
          </button>
          <ReportIssueAction
            context={createReportIssueDraftContext({
              title: this.props.title,
              // Real error text goes ONLY into `capture.cause`, never here -
              // this is the public GitHub-issue prefill.
              message: null,
              code: null,
              source: "Artifact editor",
              capture,
            })}
            presentation="icon"
            className={undefined}
          />
        </div>
      </div>
    );
  }
}
