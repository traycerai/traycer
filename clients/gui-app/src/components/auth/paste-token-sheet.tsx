import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useAuthApplyPastedToken } from "@/hooks/auth/use-auth-apply-pasted-token-mutation";

export interface PasteTokenSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * Manual paste-token sign-in sheet.
 *
 * The shell-driven OAuth flow is the primary path; this surface exists for
 * users on shells where the browser callback cannot reach the GUI (corporate
 * networks, headless dev hosts) and contributors testing against a paste-only
 * dev token. Submitting routes through `AuthService.applyPastedToken` so the
 * same AuthnV3 `${authnBaseUrl}/api/v3/user` validation runs as the OAuth
 * path.
 *
 * Paste failures render an inline error under the textarea instead of
 * surfacing through `auth.getLastError()` so the global signed-out auth
 * surface (the header's "Sign in" button) is not polluted by paste-only
 * failures - only OAuth-callback failures belong on that surface. The
 * mutation hook (`useAuthApplyPastedToken`) deliberately omits an `onError`
 * toast for the same reason; this component reads `mutation.error.message`
 * to render the inline copy.
 *
 * The paste path intentionally remains available while browser OAuth is in
 * flight. `AuthService.applyPastedToken()` invalidates the earlier OAuth
 * epoch before validation so a late callback is ignored instead of reviving
 * the superseded attempt.
 */
export function PasteTokenSheet(props: PasteTokenSheetProps) {
  const [token, setToken] = useState<string>("");
  const applyToken = useAuthApplyPastedToken();

  const reset = (): void => {
    setToken("");
    applyToken.reset();
  };

  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      reset();
    }
    props.onOpenChange(next);
  };

  const handleSubmit = async (): Promise<void> => {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      return;
    }
    try {
      await applyToken.mutateAsync(trimmed);
    } catch {
      return;
    }
    reset();
    props.onOpenChange(false);
  };

  const inlineError = applyToken.error?.message ?? null;
  const canSubmit = token.trim().length > 0 && !applyToken.isPending;

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-md overflow-hidden"
        data-testid="paste-token-sheet"
        aria-describedby="paste-token-description"
      >
        <DialogHeader>
          <DialogTitle>Paste sign-in token</DialogTitle>
          <DialogDescription id="paste-token-description">
            Paste a Traycer bearer token to sign in without launching the
            browser flow.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="Sign-in token"
          data-testid="paste-token-input"
          className="field-sizing-fixed min-h-32 max-h-[40svh] resize-none overflow-y-auto"
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
            if (applyToken.error !== null) {
              applyToken.reset();
            }
          }}
          placeholder="Paste your token here…"
          rows={5}
          spellCheck={false}
        />
        {inlineError !== null ? (
          <span
            className="text-ui-xs text-destructive"
            data-testid="paste-token-error"
            role="alert"
          >
            {inlineError}
          </span>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button
              type="button"
              variant="outline"
              data-testid="paste-token-cancel"
              disabled={applyToken.isPending}
            >
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            data-testid="paste-token-submit"
            disabled={!canSubmit}
            onClick={() => {
              void handleSubmit();
            }}
          >
            <span className="inline-flex items-center gap-1.5">
              <span>Sign in</span>
              {applyToken.isPending ? (
                <AgentSpinningDots
                  className={undefined}
                  testId="paste-token-submit-spinner"
                  variant={undefined}
                />
              ) : null}
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
