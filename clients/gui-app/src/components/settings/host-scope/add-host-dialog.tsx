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
import {
  HostGlyph,
  HostPresenceDot,
} from "@/components/settings/host-scope/host-glyph";
import { formatPlatform } from "@/components/settings/host-scope/host-scope-model";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useAddHostDialogStore } from "@/stores/settings/add-host-dialog-store";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { toast } from "sonner";

// The commands that actually stand a host up, and nothing else.
//
// What used to be here was fiction on every line. `curl -fsSL
// traycer.ai/install | sh` pipes an HTML page into a shell — that path 308s to
// docs.traycer.ai/install, a Mintlify document, not a script — and
// `traycer.ai/install.ps1` is a 404, so the Windows tab printed a command that
// could only ever fail. Neither installer has ever existed: the CLI ships
// through npm and Homebrew (`clients/traycer-cli/README.md`).
//
// The step it then skipped is the one that does the work. `traycer login` ONLY
// authenticates — `commands/login.ts` says so in as many words, and refuses to
// provision a host as a side effect of signing in — so a person who ran the old
// three steps to the letter finished with no host, and this dialog watched for
// a machine that was never going to arrive.
//
// `host ensure` rather than `host install`: it resolves the archive packaged
// beside the CLI before the registry, so the host matches the CLI just
// installed, and it no-ops when the host is already installed, registered and
// running instead of stopping a live host to re-swap it.
//
// This is the terminal path only. A machine someone installs the desktop app on
// registers its own host at sign-in and never needs these instructions — and
// the download page it would point at is on THAT screen, not this one.
const CLI_NPM_COMMAND = "npm install -g @traycerai/cli";
const CLI_HOMEBREW_COMMAND = "brew install traycerai/traycer/traycer";
const LOGIN_COMMAND = "traycer login";
const HOST_ENSURE_COMMAND = "traycer host ensure";

/**
 * Tolerance when comparing a registry `createdAt` (server clock) against the
 * dialog's open time (client clock) — see the enrollment-beat-the-baseline
 * arm of the arrival check.
 */
const ENROLLED_DURING_OPEN_SLACK_MS = 2 * 60_000;

/**
 * Adding a host, as something you WATCH happen.
 *
 * The dialog used to end on a static paragraph — "Waiting for a new host to
 * come online…" — that always rendered and was never true, because nothing was
 * watching. The wait is real now and needs no sentence to say so: the registry
 * already polls every ~15s and this dialog already knows which hosts existed
 * when it opened, so the moment the new machine registers, the whole body is
 * replaced by that host's identity and a button to set it up. The arrival IS
 * the indicator; a spinner beside it only restated the header.
 */
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
      {/* Both halves, or neither works: `DialogContent`'s base class caps at
          `sm:max-w-sm`, so a lone `w-[…]` is dead weight — the panel painted at
          24rem while its grid track stretched to whatever the widest command
          needed, and every row rendered outside the box. Same pairing as the
          other wide dialogs (chat-fork, provider-skill-*). */}
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

  // The arrival: a host that was NOT in the last COMPLETE picture of the
  // account and has finished enrolling.
  //
  // Two rules, each carrying a false claim this dialog used to make:
  //
  // "Complete picture", not "open-time snapshot". The union is only whole
  // when both source lists have answered cleanly, and the click that opened
  // this dialog can land while one of them is failed or still in flight. A
  // snapshot taken then is missing every host the absent list would have
  // contributed, so a later successful retry made those PRE-EXISTING hosts
  // look new, and the banner named one of them as the machine that just
  // connected. The baseline therefore waits for the first clean read after
  // opening (`null` until then — the watcher keeps watching, claiming
  // nothing); the body remounts per open, so it resets with the dialog.
  //
  // `registered`, not `registered && connectable`. Requiring a dialable route
  // stranded exactly the users the plan gate applies to: a free-plan account
  // enrolling a remote machine sees it register, stay `connectable: false`
  // forever by design — and this dialog spun on "Watching for a new host…"
  // over a host that was already in the account. Registration is the
  // enrollment claim; the route is a separate fact the banner copy states
  // honestly either way.
  //
  // And a third rule the first two conspire to need: enrollment can BEAT the
  // deferred baseline. Waiting for a clean read is what stops pre-existing
  // hosts from being announced, but a fast machine can finish enrolling
  // inside that same window and land in the baseline — swallowed forever by
  // set membership. The registry's `createdAt` breaks the tie: a baseline
  // host enrolled after this dialog opened is the arrival being watched for.
  const listsSettled = !scope.isLoading && !scope.listsFailed;
  const [baseline, setBaseline] = useState<readonly string[] | null>(() =>
    listsSettled ? knownHostIds : null,
  );
  const [openedAtMs] = useState(() => Date.now());
  // Filled during render, not in an effect — the documented "adjusting state
  // when data changes" shape: React re-renders before committing, and the
  // arrival check below never sees a settled list without a baseline.
  if (baseline === null && listsSettled) {
    setBaseline(scope.hosts.map((host) => host.hostId));
  }

  const arrived = useMemo(() => {
    if (baseline === null) return null;
    const known = new Set(baseline);
    const openSnapshot = new Set(knownHostIds);
    return (
      scope.hosts.find((host) => {
        // Present when this dialog opened means not an arrival, however the
        // rest resolves — the person watched it exist before running anything.
        if (!host.registered || openSnapshot.has(host.hostId)) return false;
        if (!known.has(host.hostId)) return true;
        // In the baseline, but only because enrollment BEAT the first clean
        // read: a dialog opened during a failed or in-flight list waits for
        // the retry, and a fast host can register inside that window. Set
        // membership cannot tell that host from a pre-existing one the retry
        // merely revealed — the registry's enrollment time can. The slack
        // absorbs modest client/server clock skew without readmitting
        // long-standing hosts.
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
            {arrived.connectable
              ? `${arrived.name} is connected`
              : `${arrived.name} is registered`}
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
            <span className="block truncate text-ui-sm font-medium">
              {arrived.name}
            </span>
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
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={closeDialog}>
            Close
          </Button>
          <Button
            type="button"
            onClick={() => {
              scope.setHostId(arrived.hostId);
              closeDialog();
            }}
            data-testid="add-host-manage-arrived"
          >
            Set up {arrived.name}
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add host</DialogTitle>
        <DialogDescription>
          A host is Traycer running on the computer you want to reach. Run these
          over there — this window notices the moment it joins your account.
        </DialogDescription>
      </DialogHeader>

      <ol className="flex min-w-0 flex-col" data-testid="add-host-steps">
        <Step index={1} title="Install the Traycer CLI">
          <CommandBlock command={CLI_NPM_COMMAND} label="npm" />
          <CommandBlock command={CLI_HOMEBREW_COMMAND} label="brew" />
          <StepNote>
            Pick one — npm (needs Node 20.18 or newer) or Homebrew (macOS and
            Linux). Running both installs two competing copies.
          </StepNote>
        </Step>
        <Step index={2} title="Sign in">
          <CommandBlock command={LOGIN_COMMAND} label={null} />
          <StepNote>
            Prints a link and a code — open the link on any device, enter the
            code, approve. This only signs in.
          </StepNote>
        </Step>
        <Step index={3} title="Install and start the host">
          <CommandBlock command={HOST_ENSURE_COMMAND} label={null} />
          <StepNote>
            Installs the host, registers it as a background service, and starts
            it. Safe to run again if anything looks wrong.
          </StepNote>
        </Step>
      </ol>
    </>
  );
}

/**
 * One numbered step on a connected rail. The connector is drawn behind the
 * badge and stops at the last step (`group-last:hidden`), so the list reads as
 * one sequence rather than as separate rows.
 */
function Step(props: {
  readonly index: number;
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <li className="group relative flex min-w-0 gap-3 pb-4 last:pb-0">
      {/* `group-last:`, not `last:` — the rail hides on the LAST STEP, and this
          span is always its own parent's first child. */}
      <span
        aria-hidden
        className="absolute top-7 bottom-0 left-3 w-px bg-border group-last:hidden"
      />
      <span className="relative flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-ui-xs font-medium text-muted-foreground ring-1 ring-border">
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
    <span className="text-ui-xs text-muted-foreground">{props.children}</span>
  );
}

function CommandBlock(props: {
  readonly command: string;
  readonly label: string | null;
}): ReactNode {
  // The hook, not a hand-rolled writeText + timeout: it withholds the success
  // check when the write rejects (denied permission, insecure context) and
  // clears its reset timer on unmount, both of which the inline version got
  // wrong.
  const clipboard = useClipboardCopy({
    resetMs: 1600,
    onSuccess: null,
    onError: () => toast.error("Couldn't copy the command"),
  });
  return (
    <div className="group flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 transition-colors hover:bg-muted/70">
      {props.label === null ? null : (
        <span className="shrink-0 font-mono text-code-xs text-muted-foreground/70 select-none">
          {props.label}
        </span>
      )}
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
