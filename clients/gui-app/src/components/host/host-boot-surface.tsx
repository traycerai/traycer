import type { ReactNode } from "react";
import { HostBootCard } from "@/components/centered-card";
import { LocalHostLoadingContent } from "@/components/local-host-loading";
import { usePressStartActivation } from "@/lib/host/press-start-activation";

/** That is the escape hatch this family must never lose, and it has been lost twice: 1. */
export function HostBootSurface(props: {
  readonly testId: string | null;
  readonly onConfigureShell: () => void;
  readonly onOpenSettings: () => void;
}): ReactNode {
  return (
    <HostBootCard testId={props.testId} dataset={{}} viewportCapped={false}>
      <LocalHostLoadingContent
        progress={null}
        onConfigureShell={props.onConfigureShell}
        footerTrailing={
          <BootOpenSettingsButton onOpenSettings={props.onOpenSettings} />
        }
      />
    </HostBootCard>
  );
}

/** It activates on press, not on click, and that is load-bearing rather than stylistic. */
export function BootOpenSettingsButton(props: {
  readonly onOpenSettings: () => void;
}): ReactNode {
  const activation = usePressStartActivation(props.onOpenSettings);
  return (
    <button
      type="button"
      {...activation}
      data-testid="host-boot-open-settings"
      className="inline-flex items-center text-ui-xs text-muted-foreground hover:text-foreground"
    >
      Open settings
    </button>
  );
}
