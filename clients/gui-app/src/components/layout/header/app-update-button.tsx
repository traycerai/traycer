import { Download, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useDesktopAppUpdates } from "@/hooks/runner/use-desktop-app-updates";
import { cn } from "@/lib/utils";

export function AppUpdateHeaderButton() {
  const { bridge, snapshot } = useDesktopAppUpdates();
  if (bridge === null) {
    return null;
  }

  if (snapshot.status === "downloading") {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled
        className="hidden border-amber-500/30 bg-amber-500/10 text-amber-950 opacity-100 dark:text-amber-100 sm:inline-flex"
      >
        <AgentSpinningDots
          className="mr-1 size-3"
          testId={undefined}
          variant={undefined}
        />
        Downloading update
      </Button>
    );
  }

  if (snapshot.status !== "ready") {
    return null;
  }

  const latestVersion = snapshot.latestVersion;
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid="app-update-header-button"
      className={cn(
        "border-emerald-500/35 bg-emerald-500/10 text-emerald-950 hover:bg-emerald-500/15 hover:text-emerald-950 dark:text-emerald-100 dark:hover:text-emerald-100",
        "max-w-[min(42vw,14rem)]",
      )}
      title={
        latestVersion === null
          ? "Restart to update Traycer"
          : `Restart to update Traycer to v${latestVersion}`
      }
      onClick={() => {
        void bridge.installUpdate();
      }}
    >
      <Download className="size-3.5" aria-hidden />
      <span className="truncate">Restart to update</span>
      <RotateCcw className="hidden size-3 sm:block" aria-hidden />
    </Button>
  );
}
