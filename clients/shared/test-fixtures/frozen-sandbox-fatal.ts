import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { createAttachGrantProvider } from "../host-transport/remote/grant-client";

/** The reason is worded from the registry's row for `hostId`, so install that row first. */
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
    })();
    if (provision.kind !== "refused") {
      throw new Error(`the mint was not refused: ${provision.kind}`);
    }
    return provision.fatal;
  } finally {
    globalThis.fetch = realFetch;
  }
}
