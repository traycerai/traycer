import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useDeadlineReached } from "@/hooks/use-deadline-reached";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { formatClockTime } from "@/lib/relative-time";

interface InstallToken {
  readonly installToken: string;
  readonly expiresAt: number;
}

export interface TeamComputerUnattendedProps {
  readonly teamSelector: string;
  readonly pending: boolean;
  readonly token: InstallToken | null;
  readonly failure: string | null;
  readonly onMint: () => void;
}

/** Controlled by the Add a computer sheet; never persists the credential. */
export function TeamComputerUnattended(
  props: TeamComputerUnattendedProps,
): ReactNode {
  const [hasTokenHistory, setHasTokenHistory] = useState(props.token !== null);
  if (!hasTokenHistory && props.token !== null) setHasTokenHistory(true);
  const expired = useDeadlineReached(props.token?.expiresAt ?? null);
  const token = expired || props.pending ? null : props.token;
  // Pending mutation data omits the token; keep the action's label stable.
  const mintLabel =
    hasTokenHistory || props.token !== null
      ? "Create a new token"
      : "Create install token";
  // A selector is an argument, never shell source. Keep the token in stdin.
  const selector = `'${props.teamSelector.replaceAll("'", "'\\''")}'`;
  const command = `traycer host install --team ${selector} < install-token.txt`;
  const windowsSelector = `'${props.teamSelector.replaceAll("'", "''")}'`;
  const windowsCommand = `Get-Content install-token.txt | traycer host install --team ${windowsSelector}`;
  return (
    <section className="flex w-full min-w-0 flex-col items-start gap-3">
      <h3 className="text-ui-sm font-medium">Set up without signing in</h3>
      <p className="text-ui-xs text-muted-foreground">
        Use a one-time token on a computer nobody will sign in to.
      </p>
      {token === null ? (
        <p className="text-ui-xs text-muted-foreground">
          {expired
            ? "The install token expired. Create a new one to set up the computer."
            : "The token works once and expires after one hour."}
        </p>
      ) : (
        <>
          <p className="text-ui-xs">
            Save the token in a private file on the computer, then run the
            command for its terminal below. No sign-in is needed there.
          </p>
          <CopyValue
            key={`token:${token.expiresAt}`}
            label="Install token"
            value={token.installToken}
          />
          <CopyValue
            key={`command:${token.expiresAt}`}
            label="macOS and Linux command"
            value={command}
          />
          <CopyValue
            key={`windows-command:${token.expiresAt}`}
            label="Windows (PowerShell) command"
            value={windowsCommand}
          />
          <p className="text-ui-xs text-muted-foreground">
            Works once. Expires at {formatClockTime(token.expiresAt)}.
          </p>
        </>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={props.pending}
        onClick={props.onMint}
      >
        {props.pending ? (
          <AgentSpinningDots
            className={undefined}
            testId="team-computer-install-token-progress"
            variant={undefined}
          />
        ) : null}
        {mintLabel}
      </Button>
      {props.failure === null ? null : (
        <p role="alert" className="text-ui-xs text-destructive">
          {props.failure}
        </p>
      )}
    </section>
  );
}

function CopyValue(props: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  const [failed, setFailed] = useState(false);
  const { copied, copyWith } = useClipboardCopy({
    resetMs: 2_000,
    onSuccess: () => setFailed(false),
    onError: () => setFailed(true),
  });
  return (
    <div className="flex w-full min-w-0 flex-col items-start gap-1.5">
      <p className="text-ui-xs font-medium">{props.label}</p>
      <pre className="w-full min-w-0 rounded-md border border-border/60 bg-foreground/3 p-2 font-mono text-ui-xs whitespace-pre-wrap break-all">
        {props.value}
      </pre>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          copyWith(async () => {
            try {
              await navigator.clipboard.writeText(props.value);
            } catch {
              // The shared clipboard hook logs failures. Never forward an
              // exception from a credential-bearing operation to that sink.
              throw new Error("Couldn't copy. Copy the text manually.");
            }
          });
        }}
      >
        {copied ? "Copied" : `Copy ${props.label.toLowerCase()}`}
      </Button>
      {failed ? (
        <p role="alert" className="text-ui-xs text-destructive">
          Couldn&apos;t copy. Copy the text manually.
        </p>
      ) : null}
    </div>
  );
}
