export {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
export {
  HostRuntimeContext,
  HostRuntimeProvider,
  useAuthService,
  useHostBinding,
  useHostClient,
  useHostDirectory,
} from "@/lib/host/runtime";
export { HostDirectoryService } from "@/lib/host/host-directory-service";
export type { HostDirectoryServiceOptions } from "@/lib/host/host-directory-service";
export type { MessengerFactory } from "@/providers/host-runtime-provider";
export { HostStreamProvider } from "@/lib/host/stream-runtime";
export { useWsStreamClient } from "@/lib/host/stream-runtime-context";
