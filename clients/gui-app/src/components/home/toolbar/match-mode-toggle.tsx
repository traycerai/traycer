import { PillToggleButton } from "@/components/home/toolbar/pill-toggle-button";
import type { HistoryMatchMode } from "@/components/home/data/home-page.data";

interface MatchModeToggleProps {
  value: HistoryMatchMode;
  onChange: (next: HistoryMatchMode) => void;
  selectedLabel: string;
}

export function MatchModeToggle(props: MatchModeToggleProps) {
  const { value, onChange, selectedLabel } = props;
  return (
    <div className="inline-flex rounded-md border border-border/60 bg-background/60 p-0.5 font-mono text-code-xs font-medium">
      <PillToggleButton
        active={value === "any"}
        onClick={() => {
          onChange("any");
        }}
        title={`Match any selected ${selectedLabel}`}
      >
        OR
      </PillToggleButton>
      <PillToggleButton
        active={value === "all"}
        onClick={() => {
          onChange("all");
        }}
        title={`Match all selected ${selectedLabel}`}
      >
        AND
      </PillToggleButton>
    </div>
  );
}
