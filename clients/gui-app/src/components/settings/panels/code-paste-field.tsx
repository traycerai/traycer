import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ProviderProfileLoginFlowCodePaste } from "./use-provider-profile-login-flow";

/**
 * Auto-restart notice, shared verbatim by the add-profile dialog, the
 * Settings reauth panel, and the in-chat banner's waiting step - rendered
 * at the top of the step (visual-flow fixup: it previously sat squeezed
 * between the paste field's label and its input, easy to miss).
 */
export function CodePasteRestartNotice({
  message,
}: {
  readonly message: string;
}): ReactNode {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-ui-xs text-amber-900 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

/** Trailing characters left visible after masking, matching Claude's own
 *  paste-code UI (code-paste decision log's "Secrecy" row). */
const MASK_VISIBLE_SUFFIX_LENGTH = 4;

/** Mirrors the CLI's own client-side check (code-paste decision log's
 *  "Client-side validation" row): trimmed text must contain `#` with
 *  non-empty parts on both sides. */
function isValidPastedCode(code: string): boolean {
  const hashIndex = code.indexOf("#");
  return hashIndex > 0 && hashIndex < code.length - 1;
}

function maskCode(code: string): string {
  const visible = code.slice(-MASK_VISIBLE_SUFFIX_LENGTH);
  return "•".repeat(Math.max(code.length - visible.length, 0)) + visible;
}

// The relay RPC surfaces `HostRpcError`s from the transport/host layer
// (connection drops, timeouts) - none of that is actionable detail for a
// user pasting a sign-in code, so one friendly line covers all of it,
// keeping the surface inline-only per gui-app AGENTS.md's error-mapping rule.
const SUBMIT_ERROR_MESSAGE =
  "Couldn't send the code to the sign-in process. Try again.";

/**
 * Always-visible paste field rendered inside the shared waiting step when
 * the provider's `codePaste` capability is present.
 *
 * Locking is derived from `codePaste.phase`, which is itself derived from the
 * submit mutation within the active waiting attempt. The field locks and masks
 * while the action owns the attempt, then unlocks if the relay fails so the
 * same code can be retried. `lastSubmittedCode` only records what to mask.
 *
 * The raw code never leaves this component except through
 * `codePaste.submit` - it is not logged and does not appear in the masked
 * display once locked.
 */
export function CodePasteField({
  codePaste,
  disabled,
  visibleLabel,
}: {
  readonly codePaste: ProviderProfileLoginFlowCodePaste;
  readonly disabled: boolean;
  /** `false` when nearby fallback copy already introduces the field. The
   *  label remains available to assistive technology. */
  readonly visibleLabel: boolean;
}): ReactNode {
  const inputId = useId();
  const [rawCode, setRawCode] = useState("");
  const [lastSubmittedCode, setLastSubmittedCode] = useState<string | null>(
    null,
  );
  // Synchronous event guard: mutation state updates on the next render, so a
  // paste immediately followed by Enter must still be unable to submit twice.
  // An RPC error explicitly reopens the guard for a retry.
  const submitStartedRef = useRef(false);

  const locked =
    codePaste.phase === "submitting" || codePaste.phase === "verifying";
  const trimmed = rawCode.trim();
  const isValid = isValidPastedCode(trimmed);
  const showFormatHint = !locked && trimmed.length > 0 && !isValid;
  const displayValue =
    locked && lastSubmittedCode !== null
      ? maskCode(lastSubmittedCode)
      : rawCode;

  // A failed relay reopens the synchronous event gate only after React has
  // committed the unlocked error state. During the next paste event the stale
  // error prop may still be visible to event closures, but the ref is set back
  // to true before any same-tick Enter event can run.
  useEffect(() => {
    if (codePaste.submitError !== null && !locked) {
      submitStartedRef.current = false;
    }
  }, [codePaste.submitError, locked]);

  // Idempotent under disabled/locked so a stray Enter (or a paste racing an
  // already-in-flight submit) can never re-submit or resubmit a code that
  // already went out.
  const submit = (code: string): void => {
    if (disabled || locked) return;
    if (submitStartedRef.current) return;
    if (!isValidPastedCode(code)) return;
    submitStartedRef.current = true;
    setLastSubmittedCode(code);
    codePaste.submit(code);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={inputId}
        className={cn(
          "text-ui-xs font-medium text-foreground",
          !visibleLabel && "sr-only",
        )}
      >
        Paste the code
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          type="text"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 font-mono text-ui-sm"
          placeholder="Paste code"
          value={displayValue}
          disabled={disabled}
          readOnly={locked}
          onFocus={codePaste.touch}
          onChange={(event) => {
            if (locked) return;
            setRawCode(event.target.value);
            codePaste.touch();
          }}
          onPaste={(event) => {
            if (locked) return;
            event.preventDefault();
            const pasted = event.clipboardData.getData("text").trim();
            setRawCode(pasted);
            codePaste.touch();
            submit(pasted);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit(trimmed);
          }}
        />
        <Button
          type="button"
          size="icon-sm"
          variant="secondary"
          aria-label="Submit code"
          disabled={disabled || locked || !isValid}
          onClick={() => submit(trimmed)}
        >
          {codePaste.phase !== "idle" ? (
            <MutedAgentSpinner />
          ) : (
            <ArrowRight className="size-3.5" />
          )}
        </Button>
      </div>
      {showFormatHint ? (
        <p className="text-ui-xs text-muted-foreground">
          The code should look like <code>abc123#xyz789</code>.
        </p>
      ) : null}
      {codePaste.submitError !== null ? (
        <p className="text-ui-xs text-destructive">{SUBMIT_ERROR_MESSAGE}</p>
      ) : null}
    </div>
  );
}
