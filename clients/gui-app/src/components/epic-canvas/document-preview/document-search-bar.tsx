/**
 * The row under a document viewer's toolbar while its search is open: query
 * field, live match counter, previous/next, close. Shared by the PDF and
 * Word viewers so the two searches read and behave identically; each viewer
 * owns what a query DOES (pdf.js's find controller vs the DOM engine).
 */
import type { KeyboardEvent, RefObject } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface DocumentSearchBarProps {
  /** Focused by the viewer when the bar opens (an explicit user gesture). */
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  /** Enter / the arrows: step to the next (or previous) match. */
  readonly onStep: (previous: boolean) => void;
  readonly onClose: () => void;
  /** "2 / 14", "0 results", or "" while nothing has been searched yet. */
  readonly matchCountLabel: string;
}

// Destructured up front: the refs lint rule treats a props object that
// carries a ref as a ref itself, and would flag every other prop read.
export function DocumentSearchBar({
  inputRef,
  query,
  onQueryChange,
  onStep,
  onClose,
  matchCountLabel,
}: DocumentSearchBarProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && query !== "") {
      onStep(event.shiftKey);
    }
    if (event.key === "Escape") onClose();
  };
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-canvas-border/70 px-2">
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in document"
        aria-label="Find in document"
        className="h-6 min-w-0 flex-1 px-2 text-ui-xs"
      />
      <span
        className="whitespace-nowrap text-ui-xs text-muted-foreground"
        aria-live="polite"
      >
        {matchCountLabel}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={query === ""}
        onClick={() => onStep(true)}
        aria-label="Previous match"
      >
        <ChevronUp className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={query === ""}
        onClick={() => onStep(false)}
        aria-label="Next match"
      >
        <ChevronDown className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onClose}
        aria-label="Close search"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
