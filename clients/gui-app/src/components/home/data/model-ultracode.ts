import type { ModelOption } from "@/components/home/data/landing-options";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import { guiAgentModelUltracodeSchema } from "@traycer/protocol/host/agent/gui/unary-schemas";

type UltracodeCarrierMethod =
  | "epic.create"
  | "epic.createChat"
  | "epic.updateChatRunSettings";

const ULTRACODE_CARRIER_MINORS: Record<UltracodeCarrierMethod, number> = {
  "epic.create": 4,
  "epic.createChat": 4,
  "epic.updateChatRunSettings": 2,
};

export function useUltracodeCarrierSupported(
  hostId: string | null,
  method: UltracodeCarrierMethod,
): boolean {
  const version = useHostMethodSchemaVersion(hostId, method);
  return (
    version !== null &&
    version.major === 1 &&
    version.minor >= ULTRACODE_CARRIER_MINORS[method]
  );
}

/** Missing catalog metadata is unknown, never a confirmed exclusion. */
export function modelUltracodeOffered(
  model: ModelOption | null,
): boolean | undefined {
  if (model === null || model.harnessId !== "claude") return undefined;
  const parsed = guiAgentModelUltracodeSchema.safeParse(model.metadata);
  return parsed.success ? parsed.data.ultracodeOffered : undefined;
}
