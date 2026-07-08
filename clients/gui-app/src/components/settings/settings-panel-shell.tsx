import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SettingsPanelShellProps {
  title: string;
  description?: string;
  /** Optional control rendered at the top-right of the header (e.g. refresh). */
  headerAction?: ReactNode;
  /**
   * Stretch the panel to the settings scroll container's height so its body can
   * own an internal scroll instead of growing the outer settings overlay scroll.
   * The body's root element must stretch (e.g. `h-full`). Screen-size aware: the
   * height follows the modal/route scroll container, never overflowing it.
   */
  fillHeight?: boolean;
  /** Extra classes for the body card - e.g. a `max-h-*` cap under `fillHeight`. */
  bodyClassName?: string;
  children: ReactNode;
}

export function SettingsPanelShell(props: SettingsPanelShellProps) {
  const {
    title,
    description,
    headerAction,
    fillHeight,
    bodyClassName,
    children,
  } = props;
  return (
    <section
      className={cn(
        "mx-auto w-full max-w-5xl px-8 py-10",
        fillHeight && "flex h-full flex-col",
      )}
    >
      <header className="mb-8 flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <h1 className="text-title-lg font-semibold text-foreground">
            {title}
          </h1>
          {description ? (
            <p className="max-w-[72ch] text-ui-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {headerAction === undefined ? null : (
          <div className="shrink-0">{headerAction}</div>
        )}
      </header>
      <div
        className={cn(
          "overflow-hidden rounded-xl border border-border/60 bg-card/40",
          fillHeight && "min-h-0 flex-1",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}
