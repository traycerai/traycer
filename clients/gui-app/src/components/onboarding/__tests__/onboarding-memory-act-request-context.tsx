import { useEffect, useState, type ReactNode } from "react";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { useHostBinding } from "@/lib/host";

/** Holds its children back until the bound host client has a request context. */
export function RequestContext(props: {
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready || binding === null) return;
    const unsubscribe = binding.hostClient.onChange(() => setReady(true));
    binding.hostClient.setRequestContext(
      createRendererContextFixture({ bearerToken: "fixture" }),
    );
    return unsubscribe;
  }, [binding, ready]);
  return ready ? props.children : null;
}
