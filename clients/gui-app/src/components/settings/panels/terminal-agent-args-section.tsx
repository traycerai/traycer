import { useEffect, useId, useRef, useState } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Input } from "@/components/ui/input";
import { useProvidersSetTerminalAgentArgs } from "@/hooks/providers/use-providers-set-terminal-agent-args-mutation";
import { useProvidersSetProfileTerminalAgentArgs } from "@/hooks/providers/use-providers-set-profile-cli-mutation";
import { useProvidersProfileConfig } from "@/hooks/providers/use-providers-profile-config-query";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useGuiHarnessesQuery } from "@/hooks/harnesses/use-gui-harness-catalog";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";

type ProviderId = ProviderCliState["providerId"];

const TERMINAL_AGENT_ARGS_PLACEHOLDER: Record<ProviderId, string> = {
  "claude-code": "--dangerously-skip-permissions",
  codex: "--full-auto",
  opencode: "--model anthropic/claude-opus-4-8",
  cursor: "CLI arguments (optional)",
  traycer: "CLI arguments (optional)",
  openrouter: "CLI arguments (optional)",
  huggingface: "CLI arguments (optional)",
  grok: "CLI arguments (optional)",
  qwen: "CLI arguments (optional)",
  kiro: "CLI arguments (optional)",
  copilot: "CLI arguments (optional)",
  droid: "CLI arguments (optional)",
  kimi: "CLI arguments (optional)",
  kilocode: "CLI arguments (optional)",
  amp: "CLI arguments (optional)",
  devin: "CLI arguments (optional)",
  pi: "CLI arguments (optional)",
  hermes: "CLI arguments (optional)",
  omp: "CLI arguments (optional)",
  reasonix: "CLI arguments (optional)",
};

function terminalAgentArgsPlaceholder(providerId: ProviderId): string {
  return TERMINAL_AGENT_ARGS_PLACEHOLDER[providerId];
}

// Extra CLI args appended when launching this provider as a terminal agent.
// Rendered only for providers whose harness advertises the `tui` surface
// (Claude Code / Codex / OpenCode - not GUI-only providers like Cursor); the
// host launch path reads this saved value, and the launch picker pre-fills
// it for a per-launch override.
//
// D02: terminal args are ALWAYS profile-owned, so a managed profile reads and
// writes its own value through `providers.getProfileConfig` /
// `setProfileConfig` and never `providers.setTerminalAgentArgs`, which
// addresses the Default account's `provider-overrides.json` row.
export function TerminalAgentArgsSection({
  state,
  hostId,
  profileId,
}: {
  readonly state: ProviderCliState;
  readonly hostId: string | null;
  /** The switcher's current selection (D25). `null` = the Default account. */
  readonly profileId: string | null;
}) {
  const providerId = state.providerId;
  const harnessesQuery = useGuiHarnessesQuery({
    enabled: true,
    subscribed: true,
  });
  const supportsProfileConfig = useHostSupportsMethod(
    hostId,
    "providers.setProfileConfig",
  );
  const harnessId = providerIdToGuiHarnessId(providerId);
  const supportsTerminalAgent =
    harnessesQuery.data?.harnesses.some(
      (harness) => harness.id === harnessId && harness.modes.includes("tui"),
    ) ?? false;
  if (!supportsTerminalAgent) return null;
  if (profileId === null) {
    return (
      <DefaultAccountTerminalAgentArgs
        providerId={providerId}
        saved={state.terminalAgentArgs}
      />
    );
  }
  if (!supportsProfileConfig) {
    return (
      <div className="mt-3 flex flex-col gap-1 rounded-lg border border-border/60 p-3">
        <div className="text-ui-sm font-medium text-foreground">
          Terminal interface CLI arguments
        </div>
        <p className="text-ui-xs text-muted-foreground">
          This host doesn&apos;t support per-profile CLI arguments yet. Update
          the host to manage this profile&apos;s arguments here.
        </p>
      </div>
    );
  }
  return (
    <ProfileTerminalAgentArgs providerId={providerId} profileId={profileId} />
  );
}

function DefaultAccountTerminalAgentArgs({
  providerId,
  saved,
}: {
  readonly providerId: ProviderId;
  readonly saved: string;
}) {
  const setArgs = useProvidersSetTerminalAgentArgs();
  return (
    <TerminalAgentArgsField
      key={saved}
      providerId={providerId}
      saved={saved}
      pending={setArgs.isPending}
      onCommit={(terminalAgentArgs) =>
        setArgs.mutate({ providerId, terminalAgentArgs })
      }
    />
  );
}

function ProfileTerminalAgentArgs({
  providerId,
  profileId,
}: {
  readonly providerId: ProviderId;
  readonly profileId: string;
}) {
  const configQuery = useProvidersProfileConfig({
    providerId,
    profileId,
    enabled: true,
  });
  const setArgs = useProvidersSetProfileTerminalAgentArgs();
  const saved = configQuery.data?.config.terminalAgentArgs ?? null;
  // Fail closed while the profile's own value is unknown: rendering an empty
  // field over an unread config invites a blur that saves "" over real args.
  if (saved === null) {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/60 p-3">
        <MutedAgentSpinner />
        <span className="text-ui-xs text-muted-foreground">
          Loading CLI arguments…
        </span>
      </div>
    );
  }
  return (
    <TerminalAgentArgsField
      key={saved}
      providerId={providerId}
      saved={saved}
      pending={setArgs.isPending}
      onCommit={(terminalAgentArgs) =>
        setArgs.mutate({ providerId, profileId, terminalAgentArgs })
      }
    />
  );
}

function TerminalAgentArgsField({
  providerId,
  saved,
  pending,
  onCommit,
}: {
  readonly providerId: ProviderId;
  readonly saved: string;
  readonly pending: boolean;
  readonly onCommit: (terminalAgentArgs: string) => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState(saved);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // True external sync: `saved` is the canonical host value, and it can
  // change from outside this component's own `commit()` (another window's
  // edit, a differently-normalized host value). Skipped while the input is
  // focused so it never clobbers an in-progress edit.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(saved);
  }, [saved]);

  const commit = (): void => {
    const next = draft.trim();
    if (next !== draft) setDraft(next);
    // Skip only when nothing changed. Firing while a previous save is still
    // in-flight is intentional - guarding on `pending` here would silently
    // drop the latest edit.
    if (next === saved) return;
    onCommit(next);
  };

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border/60 p-3">
      <label
        htmlFor={inputId}
        className="text-ui-sm font-medium text-foreground"
      >
        Terminal interface CLI arguments
      </label>
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          id={inputId}
          className="w-full font-mono text-ui-sm"
          placeholder={terminalAgentArgsPlaceholder(providerId)}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        {pending ? <MutedAgentSpinner /> : null}
      </div>
      <p className="text-ui-xs text-muted-foreground">
        Appended to the {PROVIDER_DISPLAY_NAMES[providerId]} CLI when starting
        an agent on the Terminal interface. Pre-fills the launch picker, where
        you can override it per launch.
      </p>
    </div>
  );
}
