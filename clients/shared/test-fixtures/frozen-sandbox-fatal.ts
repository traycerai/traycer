import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { createAttachGrantProvider } from "../host-transport/remote/grant-client";

/**
 * The fatal a session ends on when authn refuses the mint of a frozen
 * sandbox's grant, as the real grant client makes it: its `reason` is worded
 * from whatever directory row the host connection registry holds for
 * `hostId` now, so the caller installs that row first.
 */
export async function refusedFrozenSandboxFatal(
  hostId: string,
): Promise<FatalErrorDetails> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: "sandbox_frozen" }), {
      status: 402,
      headers: { "Content-Type": "application/json" },
    });
  try {
    const provision = await createAttachGrantProvider({
      authnBaseUrl: "https://authn.test",
      hostId,
      getBearerToken: () => "user-bearer",
      purpose: "remote",
    })();
    if (provision.kind !== "refused") {
      throw new Error(`the mint was not refused: ${provision.kind}`);
    }
    return provision.fatal;
  } finally {
    globalThis.fetch = realFetch;
  }
}
