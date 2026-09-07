import type { DefaultHostReadinessPresentation } from "@/components/layout/host-readiness-controller-context";
import type { HostCompatibility } from "@/lib/host/compatibility-state";

/** It lives in its own module rather than as an export beside the controller because that file exports three
 * components, and a non-component export alongside them trips `react-refresh/only-export-components`. */
export function compatibilityPresentation(
  compatibility: HostCompatibility,
): DefaultHostReadinessPresentation["compatibility"] {
  if (compatibility.status === "failed") {
    return {
      status: "failed",
      degraded: false,
      unreachable: compatibility.unreachable,
      hostStatus: null,
    };
  }
  if (compatibility.status === "incompatible") {
    return {
      status: "incompatible",
      degraded: false,
      unreachable: false,
      hostStatus: null,
    };
  }
  if (compatibility.status === "checking") {
    return {
      status: "checking",
      degraded: false,
      unreachable: false,
      hostStatus: null,
    };
  }
  return {
    status: "compatible",
    degraded: compatibility.degraded,
    unreachable: false,
    hostStatus: compatibility.hostStatus,
  };
}
