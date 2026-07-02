import { type ReactNode } from "react";
import { DiffWorkerPoolProvider } from "@/components/diff-worker-pool-provider";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { TileFindOwnerBridge } from "@/components/epic-canvas/tile-find/tile-find-owner-bridge";
import { QuitInterceptBridge } from "@/components/layout/bridges/quit-intercept-bridge";
import { MigrationBlockingModalHost } from "@/components/layout/dialogs/migration-blocking-modal-host";
import { AppHeader } from "@/components/layout/header/app-header";
import { MigrationRunController } from "@/components/migration/migration-run-controller";
import { OpenFolderDialog } from "@/components/open-folder-dialog";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";

interface AppShellProps {
  children: ReactNode;
}

/**
 * Root layout shell for the signed-in main app. Auth-scoped data lifecycle
 * providers mount above the router so they survive request-context fallback
 * renders while sign-out is completing.
 */
export function AppShell(props: AppShellProps) {
  const { children } = props;
  const activeHostId = useReactiveActiveHostId();

  return (
    <DiffWorkerPoolProvider>
      <div className="min-h-screen bg-canvas text-canvas-foreground">
        <RootDndProvider>
          <div className="relative flex h-screen w-full flex-col">
            <AppHeader variant="app" />
            <main className="relative flex min-h-0 flex-1 flex-col">
              {children}
              <TileFindOwnerBridge />
            </main>
            <OpenFolderDialog />
            <QuitInterceptBridge />
            <MigrationRunController />
            <MigrationBlockingModalHost />
            {/* Test-only probe: binds the active hostId to a hidden DOM
                attribute so the mobile-cardinality integration tests can
                assert the runner-host auto-bind machinery without depending
                on the now-removed host-status footer. Hidden from a11y
                and visual layout. */}
            <span
              aria-hidden
              data-testid="active-host-probe"
              data-bound-host-id={activeHostId === null ? "" : activeHostId}
              className="sr-only"
            />
          </div>
        </RootDndProvider>
      </div>
    </DiffWorkerPoolProvider>
  );
}
