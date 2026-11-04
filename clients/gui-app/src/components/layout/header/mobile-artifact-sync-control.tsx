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
 * The phone's artifact sync control. While rooms are still retrying, desktop
 * shows only the quiet saving dot, and this header has no saving dot, so the
 * phone stays quiet too. When the host has stopped retrying, an amber dot
 * opens the sentence. Nothing once the plane is calm.
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
  if (status.kind !== "stopped" && open) {
    setOpen(false);
  }
  if (status.kind !== "stopped") return null;
  return (
    <Drawer direction="bottom" open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button
          type="button"
          variant="muted"
          size="icon-touch"
          aria-label={status.sentence}
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
        <div className="w-full min-w-0 break-words whitespace-normal p-4 pb-safe-bottom-gutter">
          <DrawerTitle>{status.title}</DrawerTitle>
          <DrawerDescription>{status.description}</DrawerDescription>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
