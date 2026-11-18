import type { ReactNode } from "react";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import { sandboxCredentialLine } from "@/lib/sandboxes/sandbox-credential-mode";
import { cn } from "@/lib/utils";

/**
 * How the browsed provider's credential works on a sandbox host, above its
 * account line. Nothing on a host that reports no mode.
 */
export function PickerSandboxCredentialLine(props: {
  readonly harness: GuiHarnessCatalogEntry | null;
}): ReactNode {
  const line =
    props.harness === null
      ? null
      : sandboxCredentialLine(
          props.harness.id,
          props.harness.sandboxCredentialMode,
          props.harness.sandboxCredentialNote,
        );
  if (line === null) return null;
  return (
    <div
      data-testid="picker-sandbox-credential-line"
      data-tone={line.tone}
      className={cn(
        "min-w-0 shrink-0 border-b px-3 py-1.5 text-ui-xs leading-snug",
        line.tone === "plain" && "text-muted-foreground",
        line.tone === "caution" && "text-warning-foreground",
        line.tone === "unavailable" && "text-destructive",
      )}
    >
      {line.text}
    </div>
  );
}
