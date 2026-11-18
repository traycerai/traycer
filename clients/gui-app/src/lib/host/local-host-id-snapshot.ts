import { getHostBindingSnapshot } from "@/lib/host/runtime";

/**
 * The host id of THIS machine, read imperatively at the moment a message is
 * sent - the directory's durable local identity, which is what
 * `useReactiveLocalHostId` projects for a render and which survives the local
 * host restarting. `null` on a shell with no local host (browser, mobile) and
 * before the runtime has resolved a binding.
 *
 * Stamped on the `chat.subscribe` `send`/`editUserMessage` frames and on a
 * create's initial message as `sentFromHostId`, beside `accountContext` and
 * read the same way: at send time, from the app's global state. NOT the
 * tab's `hostId` - the tab is bound to the machine the chat runs on; this
 * names the machine the user is typing on, which is what the host places a
 * routed browser realm by.
 */
export function readLocalHostIdSnapshot(): string | null {
  return getHostBindingSnapshot()?.directory.getLocalHostId() ?? null;
}
