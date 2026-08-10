import { useState, type ReactNode } from "react";
import { effectiveOrchestrationBinding } from "@/lib/orchestration/effective-orchestration-binding";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useOrchestrationBindingStore } from "@/stores/orchestration/orchestration-binding-store";
import { useOrchestrationEpicOverridesStore } from "@/stores/orchestration/orchestration-epic-overrides-store";
import { OrchestrationBindingPopover } from "./orchestration-binding-popover";

export interface OrchestrationBindingChipProps {
  /** Target epic for overrides. null = new-chat composer (edits global default). */
  readonly epicId: string | null;
}

/**
 * Compact create-time orchestration binding chip.
 * epicId non-null → per-epic override popover.
 * epicId null (new-chat composer) → edits the global default binding.
 *
 * Radix Popover renders in a portal — escapes the overflow-hidden composer
 * row that clipped the old absolutely-positioned panel.
 */
export function OrchestrationBindingChip(
  props: OrchestrationBindingChipProps,
): ReactNode {
  const [open, setOpen] = useState(false);
  // Subscribe so the chip re-renders when global or override maps change.
  const globalBinding = useOrchestrationBindingStore((s) => s.binding);
  const overridesByEpicId = useOrchestrationEpicOverridesStore(
    (s) => s.overridesByEpicId,
  );
  const binding = effectiveOrchestrationBinding(props.epicId);
  const hasOverride =
    props.epicId !== null && Object.hasOwn(overridesByEpicId, props.epicId);

  // Touch globalBinding so the subscription is intentional (effective reads
  // getState, so we also need the hook subscription above).
  void globalBinding;

  const label = binding.enabled
    ? `🎭 ${binding.orchestrationName} · ${binding.roleId} · ${binding.modelGroup ?? "default"}`
    : "Orchestration off";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "relative inline-flex max-w-[16rem] items-center truncate rounded-md border px-2 py-0.5 text-ui-xs",
            binding.enabled
              ? "border-border bg-muted/40 text-foreground"
              : "border-border/60 bg-transparent text-muted-foreground",
          )}
          data-testid="orchestration-binding-chip"
          aria-label="Orchestration binding"
          title={
            binding.enabled
              ? "New chat starts as this role — click to change or turn off"
              : "Orchestration off — new chats start blank"
          }
        >
          <span className="truncate">{label}</span>
          {hasOverride ? (
            <span
              className="ml-1.5 size-1.5 shrink-0 rounded-full bg-primary"
              data-testid="orchestration-binding-dirty-dot"
              aria-hidden
            />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-auto p-3">
        <OrchestrationBindingPopover
          epicId={props.epicId}
          onClose={() => {
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
