import { useState, type ComponentProps, type ReactNode } from "react";
import { EpicsListPanel } from "@/components/epics/epics-list-panel";
import type { HistoryScope } from "@/lib/history-scope";

type PanelProps = ComponentProps<typeof EpicsListPanel>;

export type ScopedPanelProps = Omit<PanelProps, "scope" | "onScopeChange"> & {
  readonly initialScope: HistoryScope;
  /** Observes every scope request the panel makes, after it is applied. */
  readonly onScopeSpy: ((scope: HistoryScope) => void) | null;
};

/** The owner every real surface is: scope lives above the panel, not in it. */
export function ScopedEpicsListPanel(props: ScopedPanelProps): ReactNode {
  const { initialScope, onScopeSpy, ...rest } = props;
  const [scope, setScope] = useState<HistoryScope>(initialScope);
  return (
    <EpicsListPanel
      {...rest}
      scope={scope}
      onScopeChange={(next) => {
        setScope(next);
        if (onScopeSpy !== null) onScopeSpy(next);
      }}
    />
  );
}
