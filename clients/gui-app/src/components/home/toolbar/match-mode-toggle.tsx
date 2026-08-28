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
        tooltip={`Match any selected ${selectedLabel}`}
        active={value === "any"}
        onClick={() => {
          onChange("any");
        }}
      >
        OR
      </PillToggleButton>
      <PillToggleButton
        tooltip={`Match all selected ${selectedLabel}`}
        active={value === "all"}
        onClick={() => {
          onChange("all");
        }}
      >
        AND
      </PillToggleButton>
    </div>
  );
}
