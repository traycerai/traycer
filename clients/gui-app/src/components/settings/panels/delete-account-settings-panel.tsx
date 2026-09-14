import { useState, type ReactNode } from "react";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { buildAccountDeletionFormUrl } from "@/lib/account/account-deletion-form";
import { useOpenLink } from "@/lib/links/open-link";

/**
 * The in-app route to deleting a Traycer account, offered by the installed
 * mobile app only (`MOBILE_APP_ONLY_SECTION_IDS` in `lib/settings-sections.ts`
 * decides that; this panel does not gate itself).
 *
 * App Store review guideline 5.1.1(v) requires an app that creates accounts to
 * let someone start deleting theirs from inside the app. Traycer has no
 * deletion RPC - the request reaches support through a form and a person
 * performs the deletion - so what this page owes the reader is honesty about
 * that: what goes, that it cannot be undone, how long it takes, and how they
 * will know it is done. It deliberately does NOT claim the account is gone
 * when the button is pressed.
 *
 * Two deliberate shapes:
 *
 * - **A confirm in front of the button.** Not because the tap destroys
 *   anything - it opens a form - but because it leaves the app for the
 *   browser, and a destructive-sounding control that silently backgrounds the
 *   app reads as "it already happened". The confirm is where the "your account
 *   stays active until..." sentence lands, which is the one thing a reader
 *   needs before the handoff rather than after it.
 * - **The account's email, shown.** The form is pre-filled from it, so the
 *   line under the button is what lets someone notice they are about to
 *   request deletion of the wrong account before they submit. Omitted rather
 *   than faked when the address has not resolved: the form still opens, with
 *   its address questions left blank for the user.
 */
export function DeleteAccountSettingsPanel(): ReactNode {
  const query = useAuthUser();
  const openLink = useOpenLink();
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Blank is "not resolved", not an address: `User.email` is nullable on the
  // wire, and an empty string would pre-fill the form with nothing while the
  // line below claimed an account was named.
  const rawEmail = query.data?.user.email ?? null;
  const email = rawEmail !== null && rawEmail.length > 0 ? rawEmail : null;

  return (
    <SettingsPanelShell
      title="Delete account"
      description="Permanently delete your Traycer account and all associated data."
    >
      <div className="flex flex-col items-start gap-4 px-5 py-5">
        <p className="max-w-[72ch] text-ui-sm text-muted-foreground">
          Deleting your account removes your profile, sessions, epics, chats and
          generated documents from Traycer. This cannot be undone.
        </p>
        <p className="max-w-[72ch] text-ui-sm text-muted-foreground">
          Requests are processed by our team within 30 days. You will receive a
          confirmation email at the address on your account when the deletion is
          complete.
        </p>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          data-testid="delete-account-request"
          onClick={() => {
            setConfirmOpen(true);
          }}
        >
          Request account deletion
        </Button>
        {email === null ? null : (
          <p
            className="text-ui-xs text-muted-foreground"
            data-testid="delete-account-signed-in-as"
          >
            Signed in as {email}.
          </p>
        )}
      </div>
      <ConfirmDestructiveDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Request account deletion?"
        description="We will open a short form to confirm your request. Your account stays active until our team completes the deletion."
        cascadeSummary={null}
        blockedReason={null}
        actionLabel="Continue"
        // Nothing to await: the open goes through the link seam, which owns its
        // own failure toast, and this panel has no state riding on the result.
        isPending={false}
        onConfirm={() => {
          setConfirmOpen(false);
          // `account` is the kind every billing/identity destination uses -
          // hard-external, so the in-app link preference never applies, and the
          // runner-error mapping behind the seam turns a shell that cannot open
          // links into a visible failure rather than a dead tap. No click event
          // to forward: the gesture that reached here was the confirm, not the
          // original press.
          void openLink(buildAccountDeletionFormUrl(email), "account", null);
        }}
      />
    </SettingsPanelShell>
  );
}
