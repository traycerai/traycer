import { useRef, useState } from "react";
import { Zap } from "lucide-react";
import {
  nonDefaultServiceTiersForModel,
  normalizeServiceTierForModel,
  standardServiceTierLabel,
} from "@/components/home/data/landing-options";
import type { ServiceTierFooterConfig } from "@/components/home/pickers/harness-model-picker-footers";
import { PickerLeaderBadge } from "@/components/home/pickers/harness-model-picker-leader-badge";
import { pickerLeaderControlLabel } from "@/components/home/pickers/harness-model-picker-shortcut-hint";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { usePickerFastModeLeader } from "@/providers/keybinding-context";

interface ServiceTierMenuButtonProps {
  readonly config: ServiceTierFooterConfig;
  readonly inlineShortcut: boolean;
}

export function ServiceTierMenuButton(props: ServiceTierMenuButtonProps) {
  const { config, inlineShortcut } = props;
  const leader = usePickerFastModeLeader();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
    null,
  );
  const options = nonDefaultServiceTiersForModel(config.selectedModel);
  const selected = normalizeServiceTierForModel(
    config.value,
    config.selectedModel,
  );
  const selectedName =
    options.find((option) => option.id === selected)?.label ??
    standardServiceTierLabel(config.selectedModel);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setPortalContainer(
            triggerRef.current?.closest<HTMLElement>(
              '[data-slot="popover-content"]',
            ) ?? null,
          );
        }
        setOpen(next);
      }}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          data-picker-speed-menu=""
          aria-label={pickerLeaderControlLabel(
            `Speed: ${selectedName}`,
            9,
            leader,
            "to change",
          )}
          className={cn(
            "relative flex min-w-0 max-w-[min(34vw,8rem)] items-center gap-1.5 rounded-md px-2 py-1 text-ui-xs text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
            selected.length > 0 && "bg-accent/70 text-foreground",
          )}
        >
          <span className="relative size-3.5 shrink-0">
            <Zap
              className={cn(
                "size-full",
                selected.length > 0 && "fill-current text-warning-foreground",
                inlineShortcut && leader !== null && "invisible",
              )}
              strokeWidth={2}
            />
            {inlineShortcut ? (
              <PickerLeaderBadge
                modifier={leader}
                index={9}
                testId="model-speed-digit-0"
                placement="center"
              />
            ) : null}
          </span>
          <span className="relative inline-flex min-w-0 items-center">
            <span className="truncate">{selectedName}</span>
            <PickerLeaderBadge
              modifier={inlineShortcut ? null : leader}
              index={9}
              testId="model-speed-digit-0"
              placement="trailing"
            />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        data-picker-speed-menu=""
        className="w-[min(85vw,20rem)]"
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
        // The panel clips its footer; its parent keeps the menu in the same
        // overlay subtree without cutting off rows beyond the panel edge.
        container={
          portalContainer?.parentElement ?? portalContainer ?? undefined
        }
      >
        <DropdownMenuRadioGroup
          value={selected}
          onValueChange={(next) => {
            if (next === "" || options.some((option) => option.id === next)) {
              config.onChange(next);
            }
          }}
        >
          <DropdownMenuRadioItem value="">
            {standardServiceTierLabel(config.selectedModel)}
          </DropdownMenuRadioItem>
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.id}
              value={option.id}
              className="items-start"
            >
              <span className="flex min-w-0 flex-col">
                <span>{option.label}</span>
                {option.description === null ? null : (
                  <span className="text-ui-xs text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
