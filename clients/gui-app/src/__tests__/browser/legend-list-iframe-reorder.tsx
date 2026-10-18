import { LegendList } from "@legendapp/list/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SandboxFrame } from "@/components/sandbox/sandbox-frame";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SandboxStatus } from "@/lib/sandbox/bridge-host";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * The chat transcript's list (`LegendList`) holding two rows that each run a
 * real sandboxed page through the real `SandboxFrame`. `window.__reverseRows()`
 * reverses the data; the rows keep their keys, so the list's DOM-order pass
 * (`useDOMOrder`, 500 ms after the last position update) must move row
 * elements, which resets an iframe moved with `insertBefore`.
 *
 * `body[data-statuses]` collects every status a frame reported as
 * `<row>:<status>`; `window.__rowOrder()` reads the rows' DOM order.
 * `browser-tests/legend-list-iframe-reorder.spec.ts` drives it.
 */
interface Row {
  readonly id: string;
}

const ROWS: readonly Row[] = [{ id: "alpha" }, { id: "beta" }];

function record(id: string, status: SandboxStatus): void {
  const body = document.body;
  const seen = body.dataset.statuses ?? "";
  body.dataset.statuses =
    seen === "" ? `${id}:${status}` : `${seen} ${id}:${status}`;
}

export function RowView({ row }: { readonly row: Row }) {
  return (
    <div data-row={row.id} style={{ height: 120 }}>
      <SandboxFrame
        source={{ kind: "html", html: `<main>page ${row.id}</main>` }}
        kind="page"
        title={`Page ${row.id}`}
        appName={null}
        networkPolicy="open"
        appCsp={null}
        permissions={[]}
        appRequests={null}
        className=""
        height={100}
        onSize={() => undefined}
        onStatus={(status) => record(row.id, status)}
        onRequestTeardown={() => undefined}
        displayMode="inline"
        onBridge={null}
        ref={null}
      />
    </div>
  );
}

export function Harness() {
  const [rows, setRows] = useState<readonly Row[]>(ROWS);
  useEffect(() => {
    Object.assign(window, {
      __reverseRows: () => setRows((current) => [...current].reverse()),
      __rowOrder: () =>
        Array.from(document.querySelectorAll("[data-row]")).map(
          (el) => el.getAttribute("data-row") ?? "",
        ),
    });
    return () => {
      Reflect.deleteProperty(window, "__reverseRows");
      Reflect.deleteProperty(window, "__rowOrder");
    };
  }, []);
  return (
    <div style={{ height: 400, width: 400 }}>
      <LegendList<Row>
        data={rows}
        keyExtractor={(row) => row.id}
        renderItem={({ item }) => <RowView row={item} />}
        estimatedItemSize={120}
        style={{ height: 400 }}
      />
    </div>
  );
}

const client = new QueryClient();
const container = document.getElementById("root");
if (container !== null) {
  // The providers `SandboxFrame` reads through `useOpenLink` (a mutation, so a
  // query client) and the confirm dialog (tooltips, the resolved theme), as
  // `mcp-app-fullscreen.tsx` mounts them.
  createRoot(container).render(
    <QueryClientProvider client={client}>
      <ResolvedThemeContext.Provider
        value={{ resolvedTheme: "light", themePreset: "traycer-green" }}
      >
        <TooltipProvider>
          <Harness />
        </TooltipProvider>
      </ResolvedThemeContext.Provider>
    </QueryClientProvider>,
  );
}
