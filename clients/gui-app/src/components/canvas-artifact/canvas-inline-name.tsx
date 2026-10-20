import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export function CanvasInlineName({
  value,
  label,
  onCommit,
}: {
  readonly value: string;
  readonly label: string;
  readonly onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  if (!editing)
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="min-w-0 max-w-full"
        aria-label={label}
        onClick={() => {
          cancelled.current = false;
          setEditing(true);
        }}
      >
        <span className="truncate">{value}</span>
      </Button>
    );
  return (
    <Input
      className="touch-auto"
      aria-label={label}
      size="xs"
      defaultValue={value}
      ref={(node) => node?.focus()}
      onBlur={(event) => {
        const name = event.currentTarget.value.trim();
        if (!cancelled.current && name.length > 0 && name !== value)
          onCommit(name);
        setEditing(false);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.code === "Escape") {
          cancelled.current = true;
          event.currentTarget.blur();
        }
        if (event.code === "Enter") event.currentTarget.blur();
      }}
    />
  );
}
