import { useEffect, useRef, useState, type ReactNode } from "react";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";

export interface FallbackDangerZoneProps {
  /** `null` when no host is resolved; the scope clause is then dropped. */
  readonly hostLabel: string | null;
  readonly isPending: boolean;
  readonly onConfirm: () => void;
  /**
   * Take focus onto Reset as this mounts.
   *
   * The other half of the shared dialog's focus return, and it exists because
   * that half cannot cover this case: a CONFIRMED reset replaces the whole
   * editor, so the Reset button the dialog captured as its opener is detached
   * by the time the dialog closes. The panel remembers that the replacement was
   * a reset and this puts the keyboard back on the control that started it -
   * the same place a cancelled dialog leaves it.
   */
  readonly focusResetOnMount: boolean;
  /** Clears the intent above, so a later remount for another reason - a host
   * switch - does not steal focus onto a button nobody pressed. */
  readonly onFocusApplied: () => void;
  readonly status: ReactNode;
}

/**
 * Settings ▸ Fallback ▸ Danger Zone - "Reset all fallback settings".
 *
 * The only destructive action on this page, and the confirm body has to NAME ITS
 * SCOPE, because every part of that scope is something a user could reasonably
 * have guessed wrong:
 *
 *  - **what it touches** - not just the master switch. It restores the steps,
 *    both timings and the model groups, and drops per-failure overrides.
 *  - **whose, and where** - one Traycer user on one host, not the machine and
 *    not every user on it. A chat on another host can link into this page, which
 *    is exactly when an unscoped "reset everything" would be read wrong.
 *  - **what it does NOT touch** - traversals that are already armed. Their
 *    ladder, grace window, max wait and return-to-preferred were frozen into a
 *    snapshot when they armed, so a policy write cannot move them.
 *
 * The one thing the copy deliberately does NOT claim is that armed traversals
 * are wholly unaffected. They are not: the tier rung re-reads the model groups
 * LIVE at the moment it runs, so a reset does change where an already-armed
 * traversal can hop to. "Keep the steps and timings they started with" is the
 * true half, and the smaller true statement beats the tidier false one.
 */
export function FallbackDangerZone(props: FallbackDangerZoneProps): ReactNode {
  const {
    hostLabel,
    isPending,
    onConfirm,
    focusResetOnMount,
    onFocusApplied,
    status,
  } = props;
  const [confirming, setConfirming] = useState(false);
  const resetButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!focusResetOnMount) return;
    resetButtonRef.current?.focus();
    onFocusApplied();
  }, [focusResetOnMount, onFocusApplied]);
  return (
    <SettingsGroup
      title="Danger Zone"
      tone="danger"
      dataTestId="settings-fallback-danger-zone"
      fill={false}
    >
      <SettingsRow
        label="Reset all fallback settings"
        description="Puts everything on this page back to its default."
        control={
          <Button
            type="button"
            variant="destructive"
            ref={resetButtonRef}
            disabled={isPending}
            onClick={() => {
              setConfirming(true);
            }}
          >
            Reset
          </Button>
        }
      />
      {status}
      <ConfirmDestructiveDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Reset all fallback settings?"
        description={resetConfirmDescription(hostLabel)}
        // Not a cascade: the dialog's cascade slot renders "This will also
        // delete <x> nested under it", which is about descendants of a deleted
        // row. Nothing here is nested under anything.
        cascadeSummary={null}
        actionLabel="Reset"
        isPending={isPending}
        blockedReason={null}
        onConfirm={() => {
          setConfirming(false);
          onConfirm();
        }}
      />
    </SettingsGroup>
  );
}

/**
 * The scope sentence.
 *
 * "restores the default model groups" rather than "clears" them: a reset clears
 * the seed MARKER, and the next read of this row seeds the defaults again, so a
 * user who was told their groups were cleared would reopen the page and find a
 * full list. Describing the state they will actually see is the only honest
 * option - the alternative would be a promise the store contradicts one read
 * later.
 *
 * The host clause is dropped when no host is resolved, matching the panel
 * description: with nothing to name, "on No host" is worse than silence.
 *
 * Deliberately NOT exported. `react(only-export-components)` flagged it, and
 * the rule is right on the merits here rather than merely satisfiable: a unit
 * test of this string would pass even if the dialog passed it the wrong host or
 * never rendered it, so the assertion worth having is on the rendered dialog,
 * which needs no export.
 */
function resetConfirmDescription(hostLabel: string | null): string {
  const what =
    "Turns automatic fallback off, restores the default steps, timings and model groups, and clears any per-failure overrides.";
  const inFlight =
    "Chats already waiting or switching keep the steps and timings they started with.";
  if (hostLabel === null) return `${what} ${inFlight}`;
  return `${what} Applies to your chat agents on ${hostLabel}. ${inFlight}`;
}
