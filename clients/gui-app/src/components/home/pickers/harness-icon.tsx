import { cn } from "@/lib/utils";
import { PROVIDER_ICON_CONFIG } from "@/components/home/data/harness-icon-map";
import type { ProviderId } from "@/components/home/data/landing-options";

interface HarnessIconProps {
  harnessId: ProviderId;
  className?: string;
}

export function HarnessIcon(props: HarnessIconProps) {
  const { harnessId, className } = props;
  // Persisted selections (Zustand) can carry harness ids that are no longer
  // in the catalog after a rename/removal - fall back to a neutral square
  // instead of crashing the whole app on `undefined.Icon`. The
  // `noUncheckedIndexedAccess: false` setting hides the runtime gap from
  // the type checker, so we gate the lookup with `Object.hasOwn`.
  if (!Object.hasOwn(PROVIDER_ICON_CONFIG, harnessId)) {
    return (
      <span aria-hidden="true" className={cn("size-4 shrink-0", className)} />
    );
  }
  const { Icon, className: iconClassName } = PROVIDER_ICON_CONFIG[harnessId];

  return (
    <Icon
      aria-hidden="true"
      className={cn("size-4 shrink-0", iconClassName, className)}
    />
  );
}
