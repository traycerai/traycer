import {
  splitConnectionManifest,
  type SplitConnectionManifest,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

export function thanosHostManifest(): SplitConnectionManifest {
  return splitConnectionManifest(hostRpcRegistry, RELEASED_FLOOR_METHOD_NAMES);
}
