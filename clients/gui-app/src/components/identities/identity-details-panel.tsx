/**
 * The identity tab's right-hand panel: the selected file's version history,
 * and the identity's settings, on two tabs.
 *
 * The history panel is keyed by path so its "older pages" state starts over
 * when the selection moves - a page list loaded for one file must never be
 * merged into another file's.
 */
import { useState, type ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IdentityHistoryPanel } from "./identity-history-panel";
import { IdentitySettingsPanel } from "./identity-settings-panel";

export interface IdentityDetailsPanelProps {
  readonly identityId: string;
  readonly hostId: string;
  readonly selectedPath: string | null;
}

type DetailsTab = "history" | "settings";

function isDetailsTab(value: string): value is DetailsTab {
  return value === "history" || value === "settings";
}

export function IdentityDetailsPanel(
  props: IdentityDetailsPanelProps,
): ReactNode {
  const { identityId, hostId, selectedPath } = props;
  const [tab, setTab] = useState<DetailsTab>("history");
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (isDetailsTab(value)) setTab(value);
      }}
      className="flex min-h-0 flex-1 flex-col"
      data-testid="identity-details-tabs"
    >
      <TabsList className="mx-2 mt-2 w-auto">
        <TabsTrigger value="history" className="flex-1">
          History
        </TabsTrigger>
        <TabsTrigger value="settings" className="flex-1">
          Settings
        </TabsTrigger>
      </TabsList>
      <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto">
        <IdentityHistoryPanel
          key={selectedPath}
          identityId={identityId}
          path={selectedPath}
        />
      </TabsContent>
      <TabsContent value="settings" className="min-h-0 flex-1 overflow-y-auto">
        <IdentitySettingsPanel identityId={identityId} hostId={hostId} />
      </TabsContent>
    </Tabs>
  );
}
