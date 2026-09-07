import { useMemo, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  HostGlyph,
  HostPresenceDot,
} from "@/components/settings/host-scope/host-glyph";
import { formatPlatform } from "@/components/settings/host-scope/host-scope-model";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useAddHostDialogStore } from "@/stores/settings/add-host-dialog-store";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { toast } from "sonner";

// A machine someone installs the desktop app on registers its own host at sign-in and never needs these
// instructions - and the download page it would point at is on that screen, not this one.
const CLI_NPM_COMMAND = "npm install -g @traycerai/cli";
const CLI_HOMEBREW_COMMAND = "brew install traycerai/traycer/traycer";
const LOGIN_COMMAND = "traycer login";
const HOST_ENSURE_COMMAND = "traycer host ensure";

/** Tolerance when comparing a registry `createdAt` (server clock) against the dialog's open time (client clock)
 * - see the enrollment-beat-the-baseline arm of the arrival check. */
const ENROLLED_DURING_OPEN_SLACK_MS = 2 * 60_000;

/** The arrival IS the indicator; a spinner beside it only restated the header. */
export function AddHostDialog(): ReactNode {
  const open = useAddHostDialogStore((s) => s.open);
  const closeDialog = useAddHostDialogStore((s) => s.closeDialog);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
    >
      {/* Both halves, or neither works: `DialogContent`'s base class caps at `sm:max-w-sm`, so a lone `w-[…]` is dead
         weight. */}
      <DialogContent
        className="w-[min(92vw,30rem)] sm:max-w-[min(92vw,30rem)]"
        data-testid="add-host-dialog"
      >
        {open ? <AddHostDialogBody /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AddHostDialogBody(): ReactNode {
  const scope = useHostScope();
  const knownHostIds = useAddHostDialogStore((s) => s.knownHostIds);
  const closeDialog = useAddHostDialogStore((s) => s.closeDialog);

  // The baseline therefore waits for the first clean read after opening (`null` until then - the watcher keeps
  // watching, claiming nothing); the body remounts per open, so it resets with the dialog.
  const listsSettled = !scope.isLoading && !scope.listsFailed;
  const [baseline, setBaseline] = useState<readonly string[] | null>(() =>
    listsSettled ? knownHostIds : null,
  );
  const [openedAtMs] = useState(() => Date.now());
  // Filled during render, not in an effect - the documented "adjusting state when data changes" shape: React
  // re-renders before committing, and the arrival check below never sees a settled list without a baseline.
  if (baseline === null && listsSettled) {
    setBaseline(scope.hosts.map((host) => host.hostId));
  }

  const arrived = useMemo(() => {
    if (baseline === null) return null;
    const known = new Set(baseline);
    const openSnapshot = new Set(knownHostIds);
    return (
      scope.hosts.find((host) => {
        // Present when this dialog opened means not an arrival, however the rest resolves - the person watched it
        // exist before running anything.
        if (!host.registered || openSnapshot.has(host.hostId)) return false;
        if (!known.has(host.hostId)) return true;
        // Set membership cannot tell that host from a pre-existing one the retry merely revealed - the registry's
        // enrollment time can.
        if (host.item === null) return false;
        const createdAtMs = Date.parse(host.item.createdAt);
        return (
          Number.isFinite(createdAtMs) &&
          createdAtMs >= openedAtMs - ENROLLED_DURING_OPEN_SLACK_MS
        );
      }) ?? null
    );
  }, [scope.hosts, baseline, knownHostIds, openedAtMs]);

  if (arrived !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {arrived.connectable ? "Host connected" : "Host registered"}
          </DialogTitle>
          <DialogDescription>
            {arrived.connectable
              ? "It registered itself and is ready to run agents."
              : "It's in your account. This window doesn't have a live connection to it, but you can manage it from Settings."}
          </DialogDescription>
        </DialogHeader>
        <div
          className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3"
          data-testid="add-host-arrived"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
            <HostGlyph host={arrived} className="size-4.5" />
          </span>
          <span className="min-w-0 flex-1">
            <TooltipWrapper
              label={arrived.name}
              side="top"
              sideOffset={undefined}
              align="start"
            >
              <span
                aria-label={arrived.name}
                className="line-clamp-2 text-ui-sm font-medium [overflow-wrap:anywhere]"
              >
                {arrived.name}
              </span>
            </TooltipWrapper>
            <span className="flex min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground">
              <HostPresenceDot
                tone={arrived.health.tone}
                animate={arrived.health.live}
                className={undefined}
              />
              <span className="truncate">
                {[arrived.health.label, formatPlatform(arrived.platform)]
                  .filter((p): p is string => p !== null && p.length > 0)
                  .join(" · ")}
              </span>
            </span>
          </span>
          <Check className="size-4 shrink-0 text-emerald-500" aria-hidden />
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            onClick={closeDialog}
          >
            Close
          </Button>
          <Button
            type="button"
            className="w-full sm:w-auto"
            onClick={() => {
              scope.setHostId(arrived.hostId);
              closeDialog();
              navigateToSettingsSection("host");
            }}
            data-testid="add-host-manage-arrived"
          >
            Set up host
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add host</DialogTitle>
        <DialogDescription className="text-pretty">
          Run these commands on the computer you want to reach. This window
          detects it when it connects.
        </DialogDescription>
      </DialogHeader>

      <ol className="flex min-w-0 flex-col" data-testid="add-host-steps">
        <Step index={1} title="Install the Traycer CLI">
          <Tabs defaultValue="npm" className="gap-1.5">
            <TabsList
              variant="line"
              aria-label="Install method"
              className="justify-start border-b border-border group-data-[orientation=horizontal]/tabs:h-7"
            >
              <TabsTrigger
                value="npm"
                className="flex-none px-2.5 py-0 text-ui-xs"
              >
                npm
              </TabsTrigger>
              <TabsTrigger
                value="homebrew"
                className="flex-none px-2.5 py-0 text-ui-xs"
              >
                Homebrew
              </TabsTrigger>
            </TabsList>
            <TabsContent value="npm" className="grid gap-1.5">
              <CommandBlock command={CLI_NPM_COMMAND} />
              <StepNote>Requires Node 20.18 or newer.</StepNote>
            </TabsContent>
            <TabsContent value="homebrew" className="grid gap-1.5">
              <CommandBlock command={CLI_HOMEBREW_COMMAND} />
              <StepNote>Available on macOS and Linux.</StepNote>
            </TabsContent>
          </Tabs>
        </Step>
        <Step index={2} title="Sign in">
          <CommandBlock command={LOGIN_COMMAND} />
          <StepNote>
            Open the link on any device, enter the code, and approve sign-in.
          </StepNote>
        </Step>
        <Step index={3} title="Install and start the host">
          <CommandBlock command={HOST_ENSURE_COMMAND} />
          <StepNote>
            Installs, registers, and starts the host. Safe to run again.
          </StepNote>
        </Step>
      </ol>
    </>
  );
}

/** The connector is drawn behind the badge and stops at the last step (`group-last:hidden`), so the list reads
 * as one sequence rather than as separate rows. */
function Step(props: {
  readonly index: number;
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <li className="group relative flex min-w-0 gap-3 pb-4 last:pb-0">
      {/* `group-last:`, not `last:` - the rail hides on the last step, and this span is always its own parent's first
         child. */}
      <span
        aria-hidden
        className="absolute top-7 bottom-0 left-3 w-px bg-border group-last:hidden"
      />
      <span className="relative flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/8 text-ui-xs font-medium text-muted-foreground ring-1 ring-border">
        {props.index}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
        <span className="text-ui-sm font-medium">{props.title}</span>
        {props.children}
      </div>
    </li>
  );
}

function StepNote(props: { readonly children: ReactNode }): ReactNode {
  return (
    <span className="text-pretty text-ui-xs text-muted-foreground">
      {props.children}
    </span>
  );
}

function CommandBlock(props: { readonly command: string }): ReactNode {
  // The hook, not a hand-rolled writeText + timeout.
  const clipboard = useClipboardCopy({
    resetMs: 1600,
    onSuccess: null,
    onError: () => toast.error("Couldn't copy the command"),
  });
  return (
    <div className="group flex min-w-0 items-center gap-2 rounded-lg border border-border bg-foreground/5 px-2.5 py-1.5 transition-colors hover:bg-foreground/6">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-code-xs whitespace-pre text-foreground">
        {props.command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="size-6 shrink-0 p-0 opacity-60 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={`Copy: ${props.command}`}
        onClick={() => clipboard.copy(props.command)}
      >
        {clipboard.copied ? (
          <Check className="size-3.5 text-emerald-500" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
    </div>
  );
}
