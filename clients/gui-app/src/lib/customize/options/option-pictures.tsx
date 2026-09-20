import { rateLimitCapableProviderIdSchema } from "@traycer/protocol/host/rate-limit";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { getLeftPanelDefinition } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { LEFT_PANEL_IDS } from "@/stores/epics/left-panel-store";
import { Button } from "@/components/ui/button";
import { Bot, Cpu, FileDiff, History, Shield } from "lucide-react";
import { ComposerAttachImageTrigger } from "@/components/home/toolbar/composer-attach-image-button";
import { ComposerMicButton } from "@/components/home/toolbar/composer-mic-button";
import { PermissionsTrigger } from "@/components/home/pickers/permissions-picker";
import { HarnessModelTrigger } from "@/components/home/pickers/harness-model-trigger";
import { ContextUsageChipView } from "@/components/chat/context-usage-chip";
import { ChatDockCompactChip } from "@/components/chat/chat-dock-compact-chip";
import { ActiveAgentsHeader } from "@/components/chat/chat-active-agents-panel";
import { BackgroundItemsHeader } from "@/components/chat/chat-background-items-panel";
import { FileChangeHeader } from "@/components/chat/segments/file-change-segment";
import { Collapsible } from "@/components/ui/collapsible";
import { HarnessModelPickerModelSettingsFooter } from "@/components/home/pickers/harness-model-picker-footers";
import { TabStripHomeItemView } from "@/components/layout/tabs/tab-strip-home-item";
import { MinimapRailTick } from "@/components/minimap/minimap-rail-tick";
import { StatusBarUsageReadings } from "@/components/layout/status-bar/status-bar-usage-readings";
import { useStatusBarUsageDisplay } from "@/components/layout/status-bar/status-bar-usage-display";
import { RateLimitGlyph } from "@/components/layout/header/rate-limit-icon";
import { ResourceUsageChip } from "@/components/resources/resource-usage-chip";
import {
  useComposerLayoutValue,
  useLayoutSetting,
  useStatusBarLayout,
} from "@/lib/layout-overrides";
import { cn } from "@/lib/utils";
import type { StatusBarRateLimitWindow } from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";

const noop = () => {};
const sampleWindow: StatusBarRateLimitWindow = {
  windowKey: "sample",
  label: "5h",
  labelIsDuration: true,
  kind: "session",
  usedPercent: 35,
  resetsAt: Date.now() + 3600000,
  severity: "healthy",
};

function FooterPicture({ providerId }: { providerId: RateLimitProviderId }) {
  const display = useStatusBarUsageDisplay();
  return (
    <StatusBarUsageReadings
      interactive={false}
      display={display}
      cluster={{
        kind: "segments",
        segments: [
          {
            providerId,
            profileId: null,
            account: null,
            hidden: false,
            state: "live",
            reason: null,
            windows: [sampleWindow],
            shown: [sampleWindow],
            tightest: sampleWindow,
          },
        ],
      }}
    />
  );
}
function ModelPicture() {
  const indicator = useComposerLayoutValue("reasoningIndicator");
  return (
    <HarnessModelTrigger
      selection={{ harnessId: "codex", modelSlug: "sample", profileId: null }}
      label="Model"
      reasoningLabel="High"
      reasoningStep={{ index: 2, count: 4 }}
      reasoningIndicator={indicator}
      serviceTierLabel={null}
      serviceTierActive={false}
      profileLabel={null}
      profileAccentDot={null}
      isLoading={false}
      disabled={false}
      labelDisplay="responsive"
    />
  );
}
function ContextPicture() {
  return (
    <ContextUsageChipView
      ref={null}
      contextEditing={false}
      onCompact={noop}
      usage={{
        inputTokens: 500,
        outputTokens: 200,
        totalTokens: 700,
        contextTokens: 500,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 100,
        contextWindow: 1000,
      }}
    />
  );
}
function MinimapPicture() {
  const placement = useLayoutSetting("chatTurnMinimapSide");
  if (placement === "hide") return <GhostPicture />;
  return (
    <div className="relative h-12 w-full min-w-0">
      {["20%", "50%", "80%"].map((top, index) => (
        <MinimapRailTick
          key={top}
          active={index === 1}
          availableWidth={24}
          hierarchical={false}
          level={1}
          open={false}
          side={placement}
          top={top}
        />
      ))}
    </div>
  );
}
function GhostPicture() {
  return (
    <span className="inline-flex size-8 rounded-sm border border-dashed border-border/60" />
  );
}
export function CustomizeOptionPicture({
  id,
  value,
}: {
  id: string;
  value: string;
}) {
  const footerDetail = id.startsWith("statusBar.usage.show");
  if (id === "chat.context.pin" || id === "chat.context.compactButton")
    return <ContextPicture />;
  if (footerDetail) return <FooterPicture providerId="codex" />;
  if (value === "hidden" || value === "false") return <GhostPicture />;
  if (id.startsWith("composer."))
    return <ComposerPicture id={id} value={value} />;
  if (id.startsWith("chat.context")) return <ContextPicture />;
  if (id === "chat.minimapSide") return <MinimapPicture />;
  if (id === "tabs.home")
    return (
      <TabStripHomeItemView isActive={false} onActivate={noop} badgeCount={0} />
    );
  return <ShellPicture id={id} value={value} />;
}
function ComposerPicture({ id, value }: { id: string; value: string }) {
  const access = useComposerLayoutValue("access");
  if (id === "composer.attachImage") return <ComposerAttachImageTrigger />;
  if (id === "composer.mic")
    return (
      <ComposerMicButton
        control={{
          state: "idle",
          onToggle: noop,
          onStop: noop,
          onCancel: noop,
          getStream: () => null,
        }}
      />
    );
  if (id === "composer.access")
    return (
      <PermissionsTrigger
        label="Full access"
        compact={access === "compact"}
        icon={<Shield className="size-4" />}
      />
    );
  if (id.includes("reasoningFooterControl"))
    return (
      <HarnessModelPickerModelSettingsFooter
        pickerOpen={false}
        serviceTier={null}
        reasoning={{
          value: "high",
          options: [
            { id: "low", label: "Low", description: null },
            { id: "medium", label: "Medium", description: null },
            { id: "high", label: "High", description: null },
          ],
          disabled: false,
          onChange: noop,
        }}
      />
    );
  if (id.startsWith("composer.model")) return <ModelPicture />;
  if (
    id === "composer.filesChanged" ||
    id === "composer.activeAgents" ||
    id === "composer.background"
  ) {
    const icons = {
      "composer.filesChanged": FileDiff,
      "composer.activeAgents": Bot,
      "composer.background": History,
    };
    const Icon = icons[id];
    if (value === "compact")
      return (
        <ChatDockCompactChip
          icon={<Icon className="size-3.5" />}
          text="1"
          working={false}
          lineDeltas={null}
          label="Sample"
          pulseToken={null}
          expanded={false}
          testId="customize-dock-picture"
          onClick={noop}
        />
      );
    if (id === "composer.filesChanged")
      return (
        <div className="flex items-center gap-1">
          <FileChangeHeader
            filePath="example.ts"
            operation="edit"
            additions={1}
            deletions={0}
            isStreaming={false}
            endState={null}
            reason="snapshot"
            clickHandlers={null}
          />
        </div>
      );
    return (
      <Collapsible open={false} variant="panel">
        {id === "composer.activeAgents" ? (
          <ActiveAgentsHeader open={false} runningCount={1} />
        ) : (
          <BackgroundItemsHeader open={false} headerSummary="1 running" />
        )}
      </Collapsible>
    );
  }
  return null;
}
function ShellPicture({ id, value }: { id: string; value: string }) {
  const providerId = rateLimitCapableProviderIdSchema.options.find(
    (provider) => id === `statusBar.provider.${provider}`,
  );
  if (providerId !== undefined)
    return <FooterPicture providerId={providerId} />;
  if (id.includes("placement") || id === "statusBar.placement")
    return (
      <div
        className={cn(
          "flex min-h-12 w-full rounded-sm border border-border/60",
          value === "header" ? "items-start" : "items-end",
        )}
      >
        {value === "header" ? (
          <RateLimitGlyph bars={[]} />
        ) : (
          <FooterPicture providerId="codex" />
        )}
      </div>
    );
  if (id === "header.usage.resourceMonitor")
    return (
      <Button variant="muted" size="icon-sm">
        <Cpu className="size-3.5" />
      </Button>
    );
  if (id === "statusBar.usage.resourceSide") return <ResourceSidePicture />;
  if (id.includes("resource") || id.includes("Resource"))
    return (
      <ResourceUsageChip
        cpuPercent={12}
        rssBytes={104857600}
        pssBytes={null}
        processCount={1}
        metrics={["cpu", "memory"]}
        label="Sample resources"
        className={undefined}
      />
    );
  if (id.startsWith("statusBar.")) return <FooterPicture providerId="codex" />;
  if (id.startsWith("header.")) return <RateLimitGlyph bars={[]} />;
  const panelId = LEFT_PANEL_IDS.find(
    (panelId) => id === `sidebar.panel.${panelId}`,
  );
  if (panelId !== undefined) {
    const Icon = getLeftPanelDefinition(panelId).icon;
    return <Icon className="size-4" />;
  }
  return null;
}

function ResourceSidePicture() {
  const side = useStatusBarLayout().resourceSide;
  return (
    <div
      className={cn(
        "flex w-full items-center gap-2",
        side === "left" && "flex-row-reverse",
      )}
    >
      <FooterPicture providerId="codex" />
      <ResourceUsageChip
        cpuPercent={12}
        rssBytes={null}
        pssBytes={null}
        processCount={1}
        metrics={["cpu"]}
        label="Sample resources"
        className={undefined}
      />
    </div>
  );
}
