import { useEffect } from "react";
import {
  hostKeyPinMismatchToast,
  untrustedCertificateToast,
} from "@/lib/toast/channels";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * The reader for the two trust refusals the shell already surfaces and nobody
 * consumed: a host key that no longer matches its pin, and a certificate this
 * machine does not trust. Both are decided in main and are already final by
 * the time they arrive - the connection is refused either way - so this exists
 * to SAY so, with the one recovery there is, rather than to ask.
 *
 * Desktop-only by construction: the surfaces hang off the Electron preload
 * bridge, so on the web and mobile shells this resolves to `null` and mounts
 * nothing. Probed structurally for the same reason the windows bridge is - a
 * preload built before either surface existed must degrade to silence, not
 * throw.
 */
export function HostTrustAlertBridge(): null {
  const runnerHost = useRunnerHostOrNull();

  useEffect(() => {
    const bridge = resolveHostTrustBridge(runnerHost);
    if (bridge === null) return;
    const pin = bridge.hostKeyPin.onMismatch((entry) => {
      hostKeyPinMismatchToast(entry.hostId).warning(
        `${entry.hostId} was refused: its host key changed since this machine first connected. If you rebuilt that machine, remove its entry from ${entry.pinLocation} and reconnect.`,
      );
    });
    const cert = bridge.certTrust.onPending((entry) => {
      untrustedCertificateToast(entry.hostname).warning(
        `${entry.hostname} was refused: its certificate is not trusted (${entry.error}). Add that certificate to this machine's system trust store to reach it.`,
      );
    });
    return () => {
      pin.dispose();
      cert.dispose();
    };
  }, [runnerHost]);

  return null;
}

interface HostKeyPinMismatchAlert {
  readonly hostId: string;
  readonly pinLocation: string;
}

interface PendingCertificateAlert {
  readonly hostname: string;
  readonly error: string;
}

interface Disposable {
  dispose: () => void;
}

/** Only the two subscriptions, of everything the desktop platform bridge has. */
interface HostTrustBridge {
  readonly hostKeyPin: {
    onMismatch(handler: (entry: HostKeyPinMismatchAlert) => void): Disposable;
  };
  readonly certTrust: {
    onPending(handler: (entry: PendingCertificateAlert) => void): Disposable;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHostKeyPinSurface(
  value: unknown,
): value is HostTrustBridge["hostKeyPin"] {
  return isRecord(value) && typeof value.onMismatch === "function";
}

function isCertTrustSurface(
  value: unknown,
): value is HostTrustBridge["certTrust"] {
  return isRecord(value) && typeof value.onPending === "function";
}

function resolveHostTrustBridge(runnerHost: unknown): HostTrustBridge | null {
  if (!isRecord(runnerHost)) return null;
  const platform: unknown = Reflect.get(runnerHost, "platform");
  if (!isRecord(platform)) return null;
  const hostKeyPin = platform.hostKeyPin;
  const certTrust = platform.certTrust;
  if (!isHostKeyPinSurface(hostKeyPin) || !isCertTrustSurface(certTrust)) {
    return null;
  }
  return { hostKeyPin, certTrust };
}
