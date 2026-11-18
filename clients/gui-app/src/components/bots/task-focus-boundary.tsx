import { Component, type ReactNode } from "react";

/** React snapshots run before DOM mutation; capture ownership there and repair it after commit. */
export class TaskFocusBoundary extends Component<{
  readonly beforeChange: () => void;
  readonly afterChange: () => void;
  readonly children: ReactNode;
}> {
  override getSnapshotBeforeUpdate(): null {
    this.props.beforeChange();
    return null;
  }

  override componentDidUpdate(): void {
    this.props.afterChange();
  }

  override componentWillUnmount(): void {
    this.props.beforeChange();
  }

  override render(): ReactNode {
    return this.props.children;
  }
}
