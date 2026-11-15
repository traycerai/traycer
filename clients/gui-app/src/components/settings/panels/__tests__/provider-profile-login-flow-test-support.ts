import type { AwaitLoginAnswer } from "@/hooks/providers/use-providers-await-login-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";

export type AwaitLoginTestAnswer = AwaitLoginAnswer;

type AwaitLoginWireResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.awaitLogin"
>;

export function awaitLoginTestAnswer(
  answer: AwaitLoginWireResponse,
): AwaitLoginTestAnswer {
  return { ...answer, signInRecordingEnded: null };
}
