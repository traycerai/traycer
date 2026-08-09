import type { HarnessSubproviderEntry } from "@/components/home/data/harness-model-search";
import type {
  ReasoningLevel,
  ReasoningLevelOption,
} from "@/components/home/data/landing-options";
import { cn } from "@/lib/utils";
import { Check, ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

interface CascadeLevelHeaderProps {
  readonly pathLabels: ReadonlyArray<string>;
  readonly backAriaLabel: string;
  readonly onBack: () => void;
}

/** Breadcrumb back control shown above models/efforts when a parent level exists. */
export function CascadeLevelHeader(props: CascadeLevelHeaderProps): ReactNode {
  const { pathLabels, backAriaLabel, onBack } = props;
  if (pathLabels.length === 0) return null;
  return (
    <div className="shrink-0 border-b px-1 py-1">
      <button
        type="button"
        aria-label={backAriaLabel}
        className="flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left text-ui-sm text-muted-foreground outline-none transition-colors hover:bg-accent/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        onClick={onBack}
      >
        <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate font-medium">
          {pathLabels.join(" / ")}
        </span>
      </button>
    </div>
  );
}

interface SubproviderListProps {
  readonly idPrefix: string;
  readonly listboxId: string;
  readonly entries: ReadonlyArray<HarnessSubproviderEntry>;
  readonly selectedGroupId: string | null;
  readonly activeId: string;
  readonly hoveredId: string;
  readonly onHover: (id: string) => void;
  readonly onActive: (id: string) => void;
  readonly onSelect: (entry: HarnessSubproviderEntry) => void;
}

export function SubproviderList(props: SubproviderListProps): ReactNode {
  const {
    idPrefix,
    listboxId,
    entries,
    selectedGroupId,
    activeId,
    hoveredId,
    onHover,
    onActive,
    onSelect,
  } = props;

  return (
    <div
      id={listboxId}
      role="listbox"
      aria-label="Subproviders"
      className="h-full overflow-y-auto overscroll-contain p-1"
    >
      {entries.map((entry) => {
        const selected = entry.providerGroupId === selectedGroupId;
        const active = entry.providerGroupId === activeId;
        const showCapacity =
          (active || entry.providerGroupId === hoveredId) &&
          entry.capacityLabel !== null;
        return (
          <div key={entry.providerGroupId} className="px-0 py-0.5">
            <button
              id={cascadeItemElementId(idPrefix, entry.providerGroupId)}
              type="button"
              role="option"
              aria-selected={selected}
              data-active={active}
              data-selected={selected}
              className={cn(
                "group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
                active && "bg-accent/30",
                selected && "bg-accent/70",
              )}
              onMouseEnter={() => {
                onHover(entry.providerGroupId);
                onActive(entry.providerGroupId);
              }}
              onFocus={() => {
                onActive(entry.providerGroupId);
              }}
              onClick={() => {
                onSelect(entry);
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium leading-5">
                  {entry.providerGroupLabel}
                </span>
                <span className="block truncate text-ui-xs text-muted-foreground">
                  {entry.modelCount === 1
                    ? "1 model"
                    : `${String(entry.modelCount)} models`}
                </span>
              </span>
              {showCapacity ? (
                <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-ui-xs text-muted-foreground">
                  {entry.capacityLabel}
                </span>
              ) : null}
              {selected ? (
                <Check className="size-4 shrink-0 text-primary" />
              ) : (
                <span className="size-4 shrink-0" />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}

interface EffortListProps {
  readonly idPrefix: string;
  readonly listboxId: string;
  readonly options: ReadonlyArray<ReasoningLevelOption>;
  readonly selectedEffort: ReasoningLevel;
  readonly activeId: string;
  readonly onHover: (id: string) => void;
  readonly onActive: (id: string) => void;
  readonly onSelect: (effort: ReasoningLevel) => void;
}

export function EffortList(props: EffortListProps): ReactNode {
  const {
    idPrefix,
    listboxId,
    options,
    selectedEffort,
    activeId,
    onHover,
    onActive,
    onSelect,
  } = props;

  return (
    <div
      id={listboxId}
      role="listbox"
      aria-label="Thinking effort"
      className="h-full overflow-y-auto overscroll-contain p-1"
    >
      {options.map((option) => {
        const selected = option.id === selectedEffort;
        const active = option.id === activeId;
        return (
          <div key={option.id} className="px-0 py-0.5">
            <button
              id={cascadeItemElementId(idPrefix, option.id)}
              type="button"
              role="option"
              aria-selected={selected}
              data-active={active}
              data-selected={selected}
              className={cn(
                "group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
                active && "bg-accent/30",
                selected && "bg-accent/70",
              )}
              onMouseEnter={() => {
                onHover(option.id);
                onActive(option.id);
              }}
              onFocus={() => {
                onActive(option.id);
              }}
              onClick={() => {
                onSelect(option.id);
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium leading-5">
                  {option.label}
                </span>
                {option.description === null ||
                option.description.length === 0 ? null : (
                  <span className="block truncate text-ui-xs text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
              {selected ? (
                <Check className="size-4 shrink-0 text-primary" />
              ) : (
                <span className="size-4 shrink-0" />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function cascadeItemElementId(
  idPrefix: string,
  itemId: string,
): string {
  return `${idPrefix}-row-${itemId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
