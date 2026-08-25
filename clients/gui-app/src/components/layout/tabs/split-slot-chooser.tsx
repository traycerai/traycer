import { type ReactNode, useCallback, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { FilePlus2 } from "lucide-react";
import { toast } from "sonner";
import { EpicsListPanel } from "@/components/epics/epics-list-panel";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { Button } from "@/components/ui/button";
import {
  commitFillableSlotDestination,
  type FillableSlotChoice,
  type FillableSlotDestination,
} from "@/components/layout/tabs/fillable-slot";
import { useHostBinding } from "@/lib/host";
import { isMobileApp } from "@/lib/mobile-app";
import { cn } from "@/lib/utils";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { tabResolveIntent, tabSurfaceDescriptor } from "@/stores/tabs/registry";
import {
  getHeaderTabs,
  useHeaderStripItems,
} from "@/stores/tabs/use-header-tabs";
import { useTabsStore } from "@/stores/tabs/store";
import type { SplitSide, SplitSideName } from "@/stores/tabs/layout";
import {
  getTabStructuralLockRevision,
  isTabStructurallyLocked,
  subscribeTabStructuralLocks,
} from "@/stores/tabs/tab-structural-lock";
import type { TabRef } from "@/stores/tabs/types";

export interface SplitSlotChooserProps {
  readonly splitId: string;
  readonly side: SplitSideName;
  readonly slot: Exclude<SplitSide, { readonly kind: "tab" }>;
  /** A header tab is hovering this slot and releasing would commit the drop. */
  readonly dropActive: boolean;
}

export function SplitSlotChooser(props: SplitSlotChooserProps): ReactNode {
  const binding = useHostBinding();
  return (
    <SplitSlotChooserContent {...props} historyAvailable={binding !== null} />
  );
}

export function SplitSlotChooserContent(
  props: SplitSlotChooserProps & { readonly historyAvailable: boolean },
): ReactNode {
  const navigate = useNavigate();
  const headerItems = useHeaderStripItems();
  // Store focus can land on this empty side without any DOM focus following
  // it (keyboard "add split", focus-side commands). Mirroring the focused
  // side into the search's focus effect gives typing somewhere to go - which
  // is worth nothing on the installed mobile app, where there is no typing
  // until a tap and a raised keyboard would cover the chooser it belongs to.
  const sideFocused = useTabsStore((state) =>
    state.items.some(
      (item) =>
        item.kind === "split" &&
        item.id === props.splitId &&
        item.focusedSide === props.side,
    ),
  );
  useSyncExternalStore(
    subscribeTabStructuralLocks,
    getTabStructuralLockRevision,
    getTabStructuralLockRevision,
  );
  const openTabs = headerItems.flatMap<FillableSlotChoice>((item) => {
    if (item.kind !== "tab") return [];
    const ref: TabRef = { kind: item.tab.kind, id: item.tab.id };
    if (
      isTabStructurallyLocked(ref) ||
      tabSurfaceDescriptor(ref.kind).splitEligibility !== "eligible"
    ) {
      return [];
    }
    return [
      {
        id: `open:${ref.kind}:${ref.id}`,
        label: item.tab.name,
        destination: { kind: "open-ref", ref },
        group: "open",
      },
    ];
  });
  const activateFocusedRef = useCallback(
    (ref: TabRef): void => {
      const tab = getHeaderTabs().find(
        (candidate) => candidate.kind === ref.kind && candidate.id === ref.id,
      );
      if (tab !== undefined) {
        navigateToTabIntent(navigate, tabResolveIntent(tab), undefined);
      }
    },
    [navigate],
  );
  const openDestination = useCallback(
    (destination: FillableSlotDestination): void => {
      const resolution = commitFillableSlotDestination({
        splitId: props.splitId,
        side: props.side,
        destination,
        activateFocusedRef,
      });
      // Rows come from shared surfaces (History) that cannot pre-filter every
      // invalid state - a structurally locked legacy Phase being the settled
      // example. A click that resolves invalid must say so, not silently
      // leave the slot empty.
      if (resolution.kind === "invalid") {
        toast.error(
          destination.kind === "phase-migration"
            ? "This Phase is locked open in another view."
            : "This view can't be opened in the split right now.",
        );
      }
    },
    [activateFocusedRef, props.side, props.splitId],
  );
  const openHistoryItem = useCallback(
    (item: HistoryItem): void => {
      openDestination(
        item.taskType === "phase"
          ? {
              kind: "phase-migration",
              phaseId: item.epicId,
              name: item.title,
            }
          : { kind: "epic", epicId: item.epicId, name: item.title },
      );
    },
    [openDestination],
  );

  return (
    <section
      aria-label={`${props.slot.kind === "unavailable" ? "Unavailable" : "Empty"} split view`}
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden border border-dashed border-border/80 bg-muted/20 transition-colors duration-150 ease-out",
        props.dropActive && "border-solid border-primary bg-primary/10",
      )}
      data-drop-active={props.dropActive ? "true" : "false"}
      data-testid={`split-slot-chooser-${props.side}`}
    >
      <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col gap-6 overflow-hidden p-[clamp(1rem,4vw,3rem)]">
        {props.dropActive ? (
          <p
            className="text-center text-ui-sm font-medium text-primary"
            aria-live="polite"
          >
            Release to open here
          </p>
        ) : null}
        {props.slot.kind === "unavailable" ? (
          <div className="px-1 py-2">
            <p className="text-ui-sm font-medium text-foreground">
              {props.slot.label}
            </p>
            <p className="mt-1 text-ui-xs text-muted-foreground">
              Choose another view for this split.
            </p>
          </div>
        ) : null}

        <SplitDestinationGroup
          id={`open-tabs-${props.splitId}-${props.side}`}
          title="Open Tabs"
          testId="split-open-tabs"
          sectionClassName={undefined}
          bodyClassName="max-h-[35vh] space-y-1 overflow-y-auto"
        >
          {openTabs.length > 0 ? (
            openTabs.map((choice) => (
              <Button
                key={choice.id}
                type="button"
                variant="ghost"
                className="h-11 w-full justify-start rounded-md px-3"
                onClick={() => openDestination(choice.destination)}
              >
                {choice.label}
              </Button>
            ))
          ) : (
            <p className="px-3 py-2 text-ui-sm text-muted-foreground">
              No other open tabs
            </p>
          )}
        </SplitDestinationGroup>

        <SplitDestinationGroup
          id={`create-${props.splitId}-${props.side}`}
          title="Create"
          testId="split-create-actions"
          sectionClassName="border-t border-border/60 pt-5"
          bodyClassName={undefined}
        >
          <Button
            type="button"
            variant="ghost"
            className="h-11 w-full justify-start rounded-md px-3"
            onClick={() => openDestination({ kind: "new-draft" })}
          >
            <FilePlus2 />
            New Task
          </Button>
        </SplitDestinationGroup>

        <SplitDestinationGroup
          id={`history-${props.splitId}-${props.side}`}
          title="History"
          testId="split-history"
          sectionClassName="flex min-h-0 flex-1 flex-col border-t border-border/60 pt-5"
          bodyClassName="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-1"
        >
          {props.historyAvailable ? (
            <EpicsListPanel
              variant="picker"
              className="mt-0"
              onSelectEpic={null}
              onOpenItem={openHistoryItem}
              routeSearch={null}
              historyNowMs={null}
              // A ternary, not `&&`: the leaked-render lint rewrites a JSX
              // `&&` into a null-armed ternary, and this prop is strictly
              // boolean - spelling both arms keeps the fixer away and the
              // types exact.
              autoFocusSearch={sideFocused ? !isMobileApp() : false}
            />
          ) : (
            <p className="px-1 py-2 text-ui-sm text-muted-foreground">
              History is unavailable while the host is disconnected.
            </p>
          )}
        </SplitDestinationGroup>
      </div>
    </section>
  );
}

interface SplitDestinationGroupProps {
  readonly id: string;
  readonly title: string;
  readonly testId: string;
  readonly sectionClassName: string | undefined;
  readonly bodyClassName: string | undefined;
  readonly children: ReactNode;
}

function SplitDestinationGroup(props: SplitDestinationGroupProps): ReactNode {
  return (
    <section
      aria-labelledby={props.id}
      data-testid={props.testId}
      className={props.sectionClassName}
    >
      <h2
        id={props.id}
        className="mb-1.5 px-1 text-ui-xs font-semibold text-muted-foreground"
      >
        {props.title}
      </h2>
      <div
        data-testid={`${props.testId}-card`}
        className={cn("overflow-hidden", props.bodyClassName)}
      >
        {props.children}
      </div>
    </section>
  );
}
