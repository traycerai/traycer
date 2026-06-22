import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PillToggleButtonProps {
  active: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}

export function PillToggleButton(props: PillToggleButtonProps) {
  const { active, onClick, title, children } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "rounded-sm px-2 py-0.5 transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
