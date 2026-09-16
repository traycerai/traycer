import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { AutoPolicyReadState } from "@traycer/protocol/host/auto-mode/contracts";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  AUTO_POLICY_MAX_BYTES,
  AUTO_POLICY_TEMPLATE,
  autoPolicyByteLength,
  autoPolicyChangedSinceLoad,
} from "@/components/settings/panels/auto-policy-document";
import { cn } from "@/lib/utils";

/**
 * Editor for the account's auto-mode policy.
 *
 * A dialog rather than an inline editor because the panel it opens from already
 * spends its height on the agent-selection guide, and a policy is a document -
 * it wants room. Save is explicit here (no debounced auto-save like the guide's)
 * for a different reason: the record is ACCOUNT-wide and last-write-wins, so
 * every keystroke auto-saved is a keystroke racing another device.
 */
export function AutoPolicyEditorDialog(props: {
  readonly initialBody: string | null;
  /** `updatedAt` as it read when this editor opened; see the stale warning. */
  readonly loadedUpdatedAt: string | null;
  /** `updatedAt` as it reads NOW - a later save from another device moves it. */
  readonly currentUpdatedAt: string | null;
  /**
   * How far the record behind `initialBody` can be trusted.
   *
   * The settings row refuses to OPEN this dialog on an `unreadable` read, so
   * the state that matters here is the one that arrives while it is already
   * open: a refetch behind the dialog can turn a policy this session loaded
   * cleanly into one the host can no longer read, and saving then overwrites a
   * record nobody can currently see. Save is disabled rather than warned
   * about, because the loss it prevents is unrecoverable.
   */
  readonly readState: AutoPolicyReadState;
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly onSave: (body: string) => void;
}) {
  const initial = props.initialBody ?? AUTO_POLICY_TEMPLATE;
  const [body, setBody] = useState(initial);
  // The text this editing session opened on, frozen at mount by the initializer
  // exactly as `body` is. A ref would hold the same value and be unreadable
  // during render (`react-hooks/refs`); it also has no reason to be mutable -
  // nothing may move this baseline while the dialog is open, which is the point
  // of it. A refetch behind the open dialog therefore cannot make a typed edit
  // look clean; `props.currentUpdatedAt` is what tells the user about that.
  const [openedWith] = useState(initial);
  const dirty = body !== openedWith;
  const bytes = autoPolicyByteLength(body);
  const overCap = bytes > AUTO_POLICY_MAX_BYTES;
  const stale = autoPolicyChangedSinceLoad(
    props.loadedUpdatedAt,
    props.currentUpdatedAt,
  );
  const unreadable = props.readState === "unreadable";
  // A read that went STALE while this dialog was open is the same hazard as an
  // unreadable one, arriving by a different door. The row refuses to OPEN the
  // editor from a stale read, but the open-time refetch can come back stale
  // behind an editor that opened on a fresh one - and a stale read withholds
  // `updatedAt`, so `autoPolicyChangedSinceLoad` (the `stale` flag above, a
  // different question) has nothing to compare and its warning is structurally
  // unable to fire. Saving from there is a last-write-wins overwrite of a
  // policy this window cannot see, with nothing on screen saying so.
  //
  // Named `readIsStale` rather than reusing `stale`: that one means "somebody
  // else saved since you opened this", and conflating the two would make the
  // wrong sentence appear.
  const readIsStale = props.readState === "stale";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Esc and the overlay are dismissals too, and dismissing mid-write
        // hides an in-flight save behind a closed dialog: the write still
        // lands, and the user has no reason to believe it did. A hang cannot
        // trap anyone here - `autoPolicy.set` carries a response timeout, and
        // an error clears `saving` with the dialog still open.
        if (open || props.saving) return;
        props.onCancel();
      }}
    >
      <DialogContent className="max-h-[min(85vh,52rem)] w-[min(92vw,46rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Auto mode policy</DialogTitle>
          <DialogDescription>
            Extra instructions for the judge that reviews actions in Auto mode.
            Say what this machine is under <em>Environment</em>, what to approve
            without asking under <em>Allow</em>, what to always ask about under
            <em> Soft deny</em>, and what to never approve under{" "}
            <em>Hard deny</em>. It applies to your account on every device, and
            a repository with a <code>.traycer/auto-policy.md</code> file uses
            that file instead. Some of Traycer&apos;s own rules always apply on
            top of yours. You&apos;ll still be asked about those, and your
            policy can&apos;t turn them off.
          </DialogDescription>
        </DialogHeader>

        {unreadable ? (
          <div
            role="status"
            data-testid="auto-policy-unreadable-warning"
            className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-700 text-ui-sm dark:text-amber-300"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Traycer can&apos;t read your saved policy right now, so saving is
              turned off - a save from here would replace a policy nobody can
              currently see. Reopen Settings to try again.
            </span>
          </div>
        ) : null}

        {readIsStale ? (
          <div
            role="status"
            data-testid="auto-policy-stale-read-warning"
            className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-700 text-ui-sm dark:text-amber-300"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Traycer is showing a copy of your policy it couldn&apos;t refresh,
              so saving is turned off - it can&apos;t tell whether another
              device has changed it since. Reopen Settings to try again.
            </span>
          </div>
        ) : null}

        {stale ? (
          <div
            role="status"
            data-testid="auto-policy-stale-warning"
            className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-ui-sm text-amber-700 dark:text-amber-300"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              This policy was saved somewhere else since you opened it. Saving
              now replaces that version.
            </span>
          </div>
        ) : null}

        {/* Locked once Save is pressed, which is the repo's pending rule
            (`disabled` while in flight, label untouched, inline spinner) applied
            to the DRAFT rather than only to the button. The request captured
            `body` at click time and the parent closes this dialog on success, so
            an editable textarea in that window silently discards everything
            typed after the click while the host stores the earlier text. The
            alternative - close only when the draft still matches what was sent -
            leaves the user holding edits that were never saved, with nothing
            saying so; refusing the edit is the honest half. */}
        <Textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          disabled={props.saving}
          aria-label="Auto mode policy"
          data-testid="auto-policy-input"
          spellCheck={false}
          className="min-h-[min(46vh,24rem)] w-full font-mono text-code-sm"
        />

        <DialogFooter className="items-center sm:justify-between">
          <span
            className={cn(
              "text-ui-xs",
              overCap ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {overCap
              ? `Too long by ${(bytes - AUTO_POLICY_MAX_BYTES).toLocaleString()} bytes - the limit is ${AUTO_POLICY_MAX_BYTES.toLocaleString()}.`
              : "Markdown. Empty sections are ignored."}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={props.saving}
              onClick={props.onCancel}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              data-testid="auto-policy-save"
              disabled={
                props.saving || overCap || !dirty || unreadable || readIsStale
              }
              onClick={() => props.onSave(body)}
            >
              {props.saving ? (
                <AgentSpinningDots
                  className={undefined}
                  testId="auto-policy-saving-spinner"
                  variant={undefined}
                />
              ) : null}
              Save policy
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
