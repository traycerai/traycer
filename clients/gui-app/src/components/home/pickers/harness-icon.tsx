import { cn } from "@/lib/utils";
import { PROVIDER_ICON_CONFIG } from "@/components/home/data/harness-icon-map";

interface HarnessIconProps {
  // An open string, not `ProviderId`: a transcript row's sender may name a
  // harness this build does not know (`chat.subscribe@1.22` carries the id as
  // written), and the `Object.hasOwn` gate below is what draws it.
  harnessId: string;
  className?: string;
}

function hasHarnessIcon(
  harnessId: string,
): harnessId is keyof typeof PROVIDER_ICON_CONFIG {
  return Object.hasOwn(PROVIDER_ICON_CONFIG, harnessId);
}

export function HarnessIcon(props: HarnessIconProps) {
  const { harnessId, className } = props;
  // Persisted selections (Zustand) can carry harness ids that are no longer
  // in the catalog after a rename/removal - fall back to a neutral square
  // instead of crashing the whole app on `undefined.Icon`. The
  // `noUncheckedIndexedAccess: false` setting hides the runtime gap from
  // the type checker, so we gate the lookup with `Object.hasOwn`.
  if (!hasHarnessIcon(harnessId)) {
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
