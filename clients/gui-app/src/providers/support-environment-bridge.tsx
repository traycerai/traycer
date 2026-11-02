import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentSecretsRotationResponse } from "@traycer/protocol/host/environment-schemas";
import { autoPolicyReadStateFor } from "@/components/settings/panels/auto-policy-document";
import { useAutoPolicyQuery } from "@/hooks/auto-mode/use-auto-policy-query";
import { startVisibleInterval } from "@/lib/dom/visible-interval";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useActiveEpicId } from "@/stores/epics/canvas/store";
import type { HostRpcRegistry } from "@/lib/host";
import { secretRotationSettled } from "@/lib/sandboxes/secret-rotation-line";
import {
  knownField,
  setSupportEnvironmentSection,
  staleField,
  unavailableField,
} from "@/lib/support-context-registry";
import {
  supportEnvironmentSection,
  type SupportEnvironmentPolicy,
  type SupportEnvironmentRotationRead,
} from "@/lib/support-environment-section";

/**
 * Writes the selected host's environment section into the support-context
 * registry, so a report opened after a crash still carries it: the store is
 * module-level, like the snapshot the registry bridge writes beside it.
 *
 * Built from the reads the Settings pages already make, without a poll of
 * its own: `environment.status`, the setup attempts and the secrets list are
 * the last answers those reads hold; a secret's rotation is re-read only
 * while it is still moving, as on the Secrets page. `unavailable` when the
 * host serves no `environment.status`.
 */
export function SupportEnvironmentBridge(): ReactNode {
  const hostId = useAddressableHostId();
  useEffect(() => {
    if (hostId === null) setSupportEnvironmentSection(unavailableField());
  }, [hostId]);
  if (hostId === null) return null;
  // Keyed by the host: a switch starts from nothing, so no read of the
  // previous host is ever written under the new one.
  return <SupportEnvironmentHost key={hostId} hostId={hostId} />;
}

const NO_PARAMS = {};
const OWN_ENVIRONMENT_PARAMS = { environmentId: null };

function SupportEnvironmentHost(props: { readonly hostId: string }): ReactNode {
  const { hostId } = props;
  const client = useHostClientForHostId(hostId);
  const statusSupported = useHostMethodSupport(hostId, "environment.status");
  const attemptsSupported = useHostMethodSupport(
    hostId,
    "environment.setup.attempts",
  );
  const listSupported = useHostMethodSupport(
    hostId,
    "environment.secrets.list",
  );
  const policySupported = useHostMethodSupport(hostId, "autoPolicy.get");
  const reachSupported = useHostMethodSupport(
    hostId,
    "environment.reachDiagnostics",
  );
  const epicId = useActiveEpicId();
  const status = useHostQuery<HostRpcRegistry, "environment.status">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.status",
    params: NO_PARAMS,
    // The status declares a condition poll, which a reader takes unless it
    // says otherwise: this one adds no cadence of its own, it reads whatever
    // the Settings pages last asked for.
    options: { enabled: statusSupported === true, poll: false },
  });
  const attempts = useHostQuery<HostRpcRegistry, "environment.setup.attempts">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.setup.attempts",
    params: NO_PARAMS,
    options: {
      enabled: statusSupported === true && attemptsSupported === true,
    },
  });
  const list = useHostQuery<HostRpcRegistry, "environment.secrets.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.secrets.list",
    params: OWN_ENVIRONMENT_PARAMS,
    options: { enabled: statusSupported === true && listSupported === true },
  });
  const reach = useHostQuery<HostRpcRegistry, "environment.reachDiagnostics">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.reachDiagnostics",
    params: { epicId },
    options: { enabled: statusSupported === true && reachSupported === true },
  });
  const [policy, setPolicy] = useState<SupportEnvironmentPolicy | null>(null);
  const [rotations, setRotations] = useState<
    ReadonlyMap<string, SupportEnvironmentRotationRead>
  >(() => new Map());

  const secrets = list.data?.secrets ?? null;
  const statusData = status.data ?? null;
  const attemptsData = attempts.data?.attempts ?? null;
  const reachData = reach.data ?? null;
  useEffect(() => {
    // Until this host has answered, nothing is known about it: a previous
    // host's section never stands in for the selected one.
    if (statusSupported !== true || statusData === null) {
      setSupportEnvironmentSection(unavailableField());
      return;
    }
    const section = supportEnvironmentSection({
      hostId,
      status: statusData,
      setupAttempts: attemptsData,
      policy,
      rotations:
        secrets === null
          ? null
          : secrets.flatMap((secret) => {
              const read = rotations.get(secret.secretId);
              return read === undefined ? [] : [read];
            }),
      reachDiagnostics: reachData,
    });
    // A host that stopped answering keeps its last answer, labelled as such.
    setSupportEnvironmentSection(
      status.isError ? staleField(section) : knownField(section),
    );
  }, [
    hostId,
    statusSupported,
    statusData,
    status.isError,
    attemptsData,
    policy,
    secrets,
    rotations,
    reachData,
  ]);

  const onRotation = useCallback(
    (secretId: string, read: SupportEnvironmentRotationRead | null): void => {
      setRotations((current) => {
        const held = current.get(secretId);
        if (read === null ? held === undefined : sameRead(held, read)) {
          return current;
        }
        const next = new Map(current);
        if (read === null) next.delete(secretId);
        else next.set(secretId, read);
        return next;
      });
    },
    [],
  );

  return (
    <>
      {policySupported === true ? (
        <SupportPolicyRead onRead={setPolicy} />
      ) : null}
      {client === null || secrets === null
        ? null
        : secrets.map((secret) => (
            <SupportRotationRead
              key={secret.secretId}
              client={client}
              secretId={secret.secretId}
              secretName={secret.name}
              onRead={onRotation}
            />
          ))}
    </>
  );
}

function sameRead(
  held: SupportEnvironmentRotationRead | undefined,
  read: SupportEnvironmentRotationRead,
): boolean {
  return (
    held !== undefined &&
    held.secretName === read.secretName &&
    held.rotation === read.rotation
  );
}

/** How often the support section re-asks the policy: half its lease. */
const SUPPORT_POLICY_REFRESH_MS = 30_000;

/**
 * The account policy's source and read state and a team host's policy state
 * and version; no body ever leaves here.
 */
function SupportPolicyRead(props: {
  readonly onRead: (policy: SupportEnvironmentPolicy | null) => void;
}): null {
  const { onRead } = props;
  const policy = useAutoPolicyQuery();
  const data = policy.data ?? null;
  const { refetch, isFetched } = policy;
  const teamHost = data !== null && data.team !== null;
  // A team host's policy state moves with its 60-second lease, and the
  // policy query never polls on its own (nor does this bridge's status
  // read): on a team host, re-ask every half lease while the window is
  // visible. Only once this viewer's read has run: `refetch` ignores the
  // query's `enabled`, which is what keeps a read off the empty viewer. A
  // personal host's `team` is always null, so it is never re-asked.
  useEffect(() => {
    if (!isFetched || !teamHost) return;
    return startVisibleInterval({
      tick: () => {
        void refetch();
      },
      intervalMs: SUPPORT_POLICY_REFRESH_MS,
      fireOnShow: true,
    });
  }, [isFetched, teamHost, refetch]);
  useEffect(() => {
    onRead(
      data === null
        ? null
        : {
            source: data.source,
            readState: autoPolicyReadStateFor(data),
            teamState: data.team?.state ?? null,
            teamPolicyVersion: data.team?.policyVersion ?? null,
          },
    );
  }, [data, onRead]);
  return null;
}

/** One listed secret's rotation, re-read only while it is still moving. */
function SupportRotationRead(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly secretId: string;
  readonly secretName: string;
  readonly onRead: (
    secretId: string,
    read: SupportEnvironmentRotationRead | null,
  ) => void;
}): null {
  const { secretId, secretName, onRead } = props;
  const [moving, setMoving] = useState(true);
  const rotation = useHostQuery<
    HostRpcRegistry,
    "environment.secrets.rotation"
  >({
    cacheKeyIdentity: undefined,
    client: props.client,
    method: "environment.secrets.rotation",
    params: { secretId, environmentId: null },
    options: { enabled: true, poll: moving },
  });
  const current: EnvironmentSecretsRotationResponse["rotation"] | undefined =
    rotation.data?.rotation;
  const stillMoving = current === undefined || !secretRotationSettled(current);
  if (stillMoving !== moving) setMoving(stillMoving);
  useEffect(() => {
    if (current === undefined) return;
    onRead(secretId, { secretName, rotation: current });
  }, [current, secretId, secretName, onRead]);
  // A secret no longer listed leaves the section with its row.
  useEffect(() => () => onRead(secretId, null), [secretId, onRead]);
  return null;
}
