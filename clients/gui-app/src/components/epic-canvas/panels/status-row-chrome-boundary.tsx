import { Component, type ErrorInfo, type ReactNode } from "react";
import { appLogger } from "@/lib/logger";

interface StatusRowChromeBoundaryState {
  readonly failed: boolean;
}

/**
 * Renders nothing when its child throws. Shared by every optional, host-backed
 * affordance in the Epic status row (originally private to
 * `epic-sweep-action.tsx`) - the honest fallback for decorative chrome is its
 * absence, not a broken-widget placeholder, and callers must only mount one
 * where the host runtime and the Epic session exist (host hooks throw when
 * either is absent or incomplete). The throw is still logged once so a real
 * regression is visible in the log rather than silently swallowed.
 */
export class StatusRowChromeBoundary extends Component<
  { readonly label: string; readonly children: ReactNode },
  StatusRowChromeBoundaryState
> {
  constructor(props: { readonly label: string; readonly children: ReactNode }) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): StatusRowChromeBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    appLogger.warn(`[epic-status-row] ${this.props.label} failed to render`, {
      error: error.message,
      componentStack: info.componentStack ?? null,
    });
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
