import type { ReactNode } from "react";
import { Info, Laptop } from "lucide-react";
import type { LocalConfigFallbackReason } from "@/components/settings/host-scope/host-scope-model";

/**
 * The two honest states a config surface can be in once it talks to the host
 * over RPC. Both replaced `RequiresLocalHostNotice`, which said "this window
 * can only read it for the host running on this computer" — a claim about a
 * missing RPC that stopped being true when `config.*` / `diagnostics.*` landed.
 */

/**
 * The host answered its handshake WITHOUT the config methods: it predates them.
 *
 * Stated as a version fact rather than a transport one, because that is what it
 * is and because it self-heals — the host re-handshakes after an update and the
 * page fills in with no app restart. `useHostSupportsMethod` fails closed, so
 * this is only ever rendered on a `false` (a completed handshake that did not
 * advertise the method), never on "not yet known".
 */
export function HostConfigUnsupportedNotice(props: {
  readonly hostName: string;
  /** What is unavailable, lower-case: "shell configuration". */
  readonly subject: string;
}): ReactNode {
  return (
    <div
      role="status"
      className="flex flex-col items-start gap-2 rounded-lg border border-border/60 bg-card/40 px-5 py-6"
      data-testid="host-config-unsupported-notice"
    >
      <div className="font-medium text-ui-sm text-foreground">
        {props.hostName} is running an older version
      </div>
      <p className="max-w-[68ch] text-ui-sm text-muted-foreground">
        This host&apos;s version doesn&apos;t support remote configuration, so
        its {props.subject} can&apos;t be changed from here. Update the host and
        this page fills in on its own.
      </p>
    </div>
  );
}

/**
 * This computer's host cannot answer for its own configuration, so the page is
 * reading and writing the on-disk store directly (the same file the host loads).
 *
 * Not an error and not a gate: everything below it works. It exists because the
 * page silently changes SOURCE here — the host process is not the one answering
 * — and it names WHICH of the two reasons applies, because they call for
 * different actions: start the host, or update it.
 */
export function LocalConfigFallbackNotice(props: {
  readonly hostName: string;
  readonly reason: LocalConfigFallbackReason;
}): ReactNode {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-border/60 bg-foreground/3 px-4 py-2.5 text-ui-xs text-muted-foreground"
      data-testid="local-config-fallback-notice"
      data-reason={props.reason}
    >
      <Info className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="max-w-[68ch]">
        {props.reason === "host-stopped" ? (
          <>
            {props.hostName} isn&apos;t running — showing this computer&apos;s
            on-disk configuration. Changes apply when it starts.
          </>
        ) : (
          <>
            {props.hostName}&apos;s version predates remote configuration —
            showing this computer&apos;s on-disk configuration. Update the host
            to configure it over the connection.
          </>
        )}
      </span>
    </div>
  );
}

/**
 * The host cannot answer for its own configuration AND this shell has no local
 * Traycer CLI to read the store from disk — so there is no source for this page
 * at all. Rare (a local host implies the desktop shell), but it is the one
 * combination the two notices above cannot describe.
 */
export function NoConfigSourceNotice(props: {
  readonly hostName: string;
}): ReactNode {
  return (
    <div
      role="status"
      className="flex flex-col items-start gap-3 rounded-lg border border-border/60 bg-card/40 px-5 py-6 text-ui-sm"
      data-testid="no-config-source-notice"
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-foreground/6 text-muted-foreground">
        <Laptop className="size-4.5" />
      </span>
      <div className="max-w-[60ch] space-y-1">
        <div className="font-medium text-foreground">
          Can&apos;t configure {props.hostName} from here
        </div>
        <p className="text-muted-foreground">
          It can&apos;t answer for its own configuration right now, and this
          shell has no local Traycer CLI to read that configuration from disk.
        </p>
      </div>
    </div>
  );
}
