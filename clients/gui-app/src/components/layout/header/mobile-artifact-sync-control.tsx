import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { useArtifactSyncStatus } from "@/components/epic-canvas/panels/use-artifact-sync-status";
import { useRegisteredEpicArtifactSyncReading } from "@/lib/epic-selectors";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import { cn } from "@/lib/utils";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

/**
 * The phone's artifact sync control. The desktop pill's status row is not
 * drawn at this width, so this says the same thing as a dot in the header, and
 * a tap opens the sentence. Nothing at all while there is nothing to say.
 */
export function MobileArtifactSyncControl(props: {
  readonly epicId: string;
}): ReactNode {
  const status = useArtifactSyncStatus(
    useRegisteredEpicArtifactSyncReading(props.epicId),
  );
  const [open, setOpen] = useState(false);
  // The drawer portals to <body>; re-assert the theme there, as every sheet
  // does.
  const { resolvedTheme, themePreset } = useResolvedTheme();
  if (status.kind !== "warning" && open) {
    setOpen(false);
  }
  if (status.kind === "calm") return null;
  if (status.kind === "recovered") {
    return (
      <span
        role="status"
        aria-label={status.label}
        data-testid="mobile-artifact-sync-recovered"
        className="flex size-10 shrink-0 items-center justify-center"
      >
        <span className="size-2 rounded-full bg-success" aria-hidden />
      </span>
    );
  }
  return (
    <Drawer direction="bottom" open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button
          type="button"
          variant="muted"
          size="icon-touch"
          aria-label={status.label}
          data-testid="mobile-artifact-sync-trigger"
          className="shrink-0"
        >
          <span className="size-2 rounded-full bg-warning" aria-hidden />
        </Button>
      </DrawerTrigger>
      <DrawerContent
        data-mobile-shell-touch-scope=""
        data-testid="mobile-artifact-sync-sheet"
        data-theme={themePreset}
        className={cn(resolvedTheme === "dark" && "dark")}
      >
        <div className="min-w-0 break-words p-4 pb-safe-bottom-gutter">
          <DrawerTitle>{status.label}</DrawerTitle>
          <DrawerDescription>{status.sentence}</DrawerDescription>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
