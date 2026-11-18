import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  simulatorSupportsAction,
  type SimulatorAction,
  type SimulatorAppearance,
  type SimulatorColorFilter,
  type SimulatorLiquidGlass,
  type SimulatorPermission,
  type SimulatorSettings,
  type SimulatorTextSize,
  type SimulatorToggleSetting,
} from "@traycer/protocol/host/simulator/actions";
import type { SimulatorPlatform } from "@traycer/protocol/host/simulator/schemas";
import {
  SettingsSegmentedControl,
  type SettingsSegmentedOption,
} from "@/components/settings/controls/settings-segmented-control";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  simulatorActionErrorText,
  useSimulatorDetailQuery,
  useSimulatorDrawerActionMutation,
} from "@/hooks/simulator/use-simulator-mutations";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The live tile's settings: appearance, text size, accessibility, location,
 * permissions, network, URLs, apps and push. Every control is ONE
 * `simulator.action`, whose answer is the fresh `simulator.detail` read, so
 * what the drawer shows is what the simulator reported, never what was
 * asked for.
 *
 * A control the simulator's platform cannot do is not drawn (the protocol's
 * per-platform table). One the host still refuses - a helper missing from
 * the installed tools - prints the host's sentence under that control.
 */
export interface SimulatorSettingsDrawerProps {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly epicId: string;
  readonly simulatorId: string;
  readonly platform: SimulatorPlatform;
  readonly onClose: () => void;
}

/** Which control an action belongs to, so its error and spinner land there. */
type ControlKey =
  | SimulatorAction["type"]
  | `setToggle:${SimulatorToggleSetting}`;

function controlKeyOf(action: SimulatorAction): ControlKey {
  return action.type === "setToggle"
    ? `setToggle:${action.setting}`
    : action.type;
}

const APPEARANCE_OPTIONS: ReadonlyArray<
  SettingsSegmentedOption<SimulatorAppearance>
> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const TEXT_SIZE_OPTIONS: ReadonlyArray<
  SettingsSegmentedOption<SimulatorTextSize>
> = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "extra-large", label: "Largest" },
];

const LIQUID_GLASS_OPTIONS: ReadonlyArray<
  SettingsSegmentedOption<SimulatorLiquidGlass>
> = [
  { value: "clear", label: "Clear" },
  { value: "tinted", label: "Tinted" },
];

const COLOR_FILTER_LABELS: Record<SimulatorColorFilter, string> = {
  none: "None",
  grayscale: "Grayscale",
  "red-green": "Red/green",
  "green-red": "Green/red",
  "blue-yellow": "Blue/yellow",
};

const TOGGLE_LABELS: Record<SimulatorToggleSetting, string> = {
  reduceMotion: "Reduce motion",
  increaseContrast: "Increase contrast",
  reduceTransparency: "Reduce transparency",
  showBorders: "Button shapes",
  voiceOver: "VoiceOver",
  networkEnabled: "Network",
};

/** Accessibility first, then the one Android-only system toggle. */
const TOGGLE_ORDER: readonly SimulatorToggleSetting[] = [
  "reduceMotion",
  "increaseContrast",
  "reduceTransparency",
  "showBorders",
  "voiceOver",
  "networkEnabled",
];

const PERMISSION_LABELS: Record<SimulatorPermission, string> = {
  camera: "Camera",
  microphone: "Microphone",
  photos: "Photos",
  contacts: "Contacts",
  calendar: "Calendar",
  reminders: "Reminders",
  location: "Location",
  notifications: "Notifications",
  motion: "Motion",
  "media-library": "Media library",
  faceid: "Face ID",
};

/** The protocol's own rule for an app id: one word, never a flag. */
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** The protocol's own rule for a URL: one token with no leading `-`. */
const URL_PATTERN = /^[^\s-]\S*$/;

function isColorFilter(value: string): value is SimulatorColorFilter {
  return Object.hasOwn(COLOR_FILTER_LABELS, value);
}
function isPermission(value: string): value is SimulatorPermission {
  return Object.hasOwn(PERMISSION_LABELS, value);
}

export function SimulatorSettingsDrawer(props: SimulatorSettingsDrawerProps) {
  const { client, hostId, epicId, simulatorId, platform } = props;
  const detail = useSimulatorDetailQuery(client, hostId, epicId, simulatorId);
  const { mutation, supported } = useSimulatorDrawerActionMutation(
    client,
    hostId,
    simulatorId,
  );
  const settings = detail.data?.settings ?? null;
  const sentKey =
    mutation.variables === undefined
      ? null
      : controlKeyOf(mutation.variables.action);
  const pendingKey = mutation.isPending ? sentKey : null;
  const failedKey = mutation.isError ? sentKey : null;
  const disabled = !supported || mutation.isPending;

  const send = (action: SimulatorAction) => {
    mutation.mutate({ epicId, simulatorId, action });
  };
  const feedback = (key: ControlKey): ReactNode => (
    <ControlFeedback
      pending={pendingKey === key}
      error={failedKey === key ? mutation.error : null}
    />
  );
  const can = (type: Exclude<SimulatorAction["type"], "setToggle">) =>
    simulatorSupportsAction(platform, { type });
  const toggles = TOGGLE_ORDER.filter((setting) =>
    simulatorSupportsAction(platform, { type: "setToggle", setting }),
  );

  return (
    <aside
      aria-label="Simulator settings"
      data-testid="simulator-settings-drawer"
      className="absolute inset-y-0 right-0 z-10 flex w-full max-w-72 flex-col border-l border-border bg-canvas text-ui-sm text-foreground shadow-lg"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-medium">Settings</span>
        {detail.isFetching ? (
          <AgentSpinningDots
            className="shrink-0"
            testId={undefined}
            variant={undefined}
            tone="muted"
          />
        ) : null}
        <Button
          type="button"
          variant="muted"
          size="icon-xs"
          aria-label="Close settings"
          onClick={props.onClose}
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3">
        {detail.isError ? (
          <p className="text-destructive" role="alert">
            Couldn&apos;t read this simulator&apos;s settings.{" "}
            {simulatorActionErrorText(detail.error)}
          </p>
        ) : null}

        <DisplaySection
          platform={platform}
          settings={settings}
          disabled={disabled}
          feedback={feedback}
          onSend={send}
        />

        {toggles.length === 0 ? null : (
          <DrawerSection title="Accessibility and system">
            {toggles.map((setting) => (
              <ToggleRow
                key={setting}
                setting={setting}
                settings={settings}
                disabled={disabled}
                feedback={feedback(`setToggle:${setting}`)}
                onChange={(value) =>
                  send({ type: "setToggle", setting, value })
                }
              />
            ))}
          </DrawerSection>
        )}

        {can("setLocation") ? (
          <LocationSection
            location={settings?.location ?? null}
            disabled={disabled}
            canClear={can("clearLocation")}
            setFeedback={feedback("setLocation")}
            clearFeedback={feedback("clearLocation")}
            onSet={(latitude, longitude) =>
              send({ type: "setLocation", latitude, longitude })
            }
            onClear={() => send({ type: "clearLocation" })}
          />
        ) : null}

        {can("openUrl") ? (
          <OpenUrlSection
            disabled={disabled}
            feedback={feedback("openUrl")}
            onOpen={(url) => send({ type: "openUrl", url })}
          />
        ) : null}

        <AppsSection
          platform={platform}
          disabled={disabled}
          feedback={feedback}
          onSend={send}
        />
      </div>
    </aside>
  );
}

function DisplaySection(props: {
  readonly platform: SimulatorPlatform;
  readonly settings: SimulatorSettings | null;
  readonly disabled: boolean;
  readonly feedback: (key: ControlKey) => ReactNode;
  readonly onSend: (action: SimulatorAction) => void;
}) {
  const { platform, settings, disabled, feedback, onSend } = props;
  const can = (type: Exclude<SimulatorAction["type"], "setToggle">) =>
    simulatorSupportsAction(platform, { type });
  return (
    <DrawerSection title="Display">
      {can("setAppearance") ? (
        <DrawerField label="Appearance" feedback={feedback("setAppearance")}>
          <SettingsSegmentedControl
            value={settings?.appearance ?? null}
            options={APPEARANCE_OPTIONS}
            ariaLabel="Appearance"
            disabled={disabled}
            onChange={(value) => onSend({ type: "setAppearance", value })}
          />
        </DrawerField>
      ) : null}
      {can("setTextSize") ? (
        <DrawerField label="Text size" feedback={feedback("setTextSize")}>
          <SettingsSegmentedControl
            value={settings?.textSize ?? null}
            options={TEXT_SIZE_OPTIONS}
            ariaLabel="Text size"
            disabled={disabled}
            onChange={(value) => onSend({ type: "setTextSize", value })}
          />
        </DrawerField>
      ) : null}
      {can("setLiquidGlass") ? (
        <DrawerField label="Liquid Glass" feedback={feedback("setLiquidGlass")}>
          <SettingsSegmentedControl
            value={settings?.liquidGlass ?? null}
            options={LIQUID_GLASS_OPTIONS}
            ariaLabel="Liquid Glass"
            disabled={disabled}
            onChange={(value) => onSend({ type: "setLiquidGlass", value })}
          />
        </DrawerField>
      ) : null}
      {can("setColorFilter") ? (
        <DrawerField label="Color filter" feedback={feedback("setColorFilter")}>
          <Select
            value={settings?.colorFilter ?? undefined}
            disabled={disabled}
            onValueChange={(value) => {
              if (isColorFilter(value)) {
                onSend({ type: "setColorFilter", value });
              }
            }}
          >
            <SelectTrigger aria-label="Color filter" size="sm">
              <SelectValue placeholder="Unknown" />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(COLOR_FILTER_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </DrawerField>
      ) : null}
    </DrawerSection>
  );
}

function DrawerSection(props: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3" aria-label={props.title}>
      <h3 className="text-ui-xs font-medium tracking-wide text-muted-foreground uppercase">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function DrawerField(props: {
  readonly label: string;
  readonly feedback: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-foreground/80">{props.label}</span>
      {props.children}
      {props.feedback}
    </div>
  );
}

/** A spinner while this control's action is in flight; the host's refusal after. */
function ControlFeedback(props: {
  readonly pending: boolean;
  readonly error: HostRpcError | null;
}) {
  if (props.pending) {
    return (
      <AgentSpinningDots
        className="shrink-0"
        testId={undefined}
        variant={undefined}
        tone="muted"
      />
    );
  }
  if (props.error === null) return null;
  return (
    <p className="text-ui-xs text-destructive" role="alert">
      {simulatorActionErrorText(props.error)}
    </p>
  );
}

function ToggleRow(props: {
  readonly setting: SimulatorToggleSetting;
  readonly settings: SimulatorSettings | null;
  readonly disabled: boolean;
  readonly feedback: ReactNode;
  readonly onChange: (value: boolean) => void;
}) {
  const value = props.settings?.[props.setting] ?? null;
  const label = TOGGLE_LABELS[props.setting];
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-foreground/80">{label}</span>
        <Switch
          checked={value === true}
          // An unread value is not shown as off: the switch stays inert until
          // the simulator says which way it is.
          disabled={props.disabled || value === null}
          aria-label={label}
          data-testid={`simulator-toggle-${props.setting}`}
          onCheckedChange={props.onChange}
        />
      </label>
      {props.feedback}
    </div>
  );
}

function parseCoordinate(text: string, limit: number): number | null {
  if (text.trim().length === 0) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || Math.abs(value) > limit) return null;
  return value;
}

function LocationSection(props: {
  readonly location: SimulatorSettings["location"];
  readonly disabled: boolean;
  readonly canClear: boolean;
  readonly setFeedback: ReactNode;
  readonly clearFeedback: ReactNode;
  readonly onSet: (latitude: number, longitude: number) => void;
  readonly onClear: () => void;
}) {
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const lat = parseCoordinate(latitude, 90);
  const lng = parseCoordinate(longitude, 180);
  return (
    <DrawerSection title="Location">
      <p className="text-muted-foreground" data-testid="simulator-location">
        {props.location === null
          ? "None set from here."
          : `${String(props.location.latitude)}, ${String(props.location.longitude)}`}
      </p>
      <div className="flex gap-2">
        <Input
          size="sm"
          inputMode="decimal"
          aria-label="Latitude"
          placeholder="Latitude"
          value={latitude}
          onChange={(event) => setLatitude(event.target.value)}
        />
        <Input
          size="sm"
          inputMode="decimal"
          aria-label="Longitude"
          placeholder="Longitude"
          value={longitude}
          onChange={(event) => setLongitude(event.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.disabled || lat === null || lng === null}
          onClick={() => {
            if (lat !== null && lng !== null) props.onSet(lat, lng);
          }}
        >
          Set location
        </Button>
        {props.canClear ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={props.disabled || props.location === null}
            onClick={props.onClear}
          >
            Clear
          </Button>
        ) : null}
      </div>
      {props.setFeedback}
      {props.clearFeedback}
    </DrawerSection>
  );
}

function OpenUrlSection(props: {
  readonly disabled: boolean;
  readonly feedback: ReactNode;
  readonly onOpen: (url: string) => void;
}) {
  const [url, setUrl] = useState("");
  const trimmed = url.trim();
  const valid = URL_PATTERN.test(trimmed);
  return (
    <DrawerSection title="Open a URL">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) props.onOpen(trimmed);
        }}
      >
        <Input
          size="sm"
          aria-label="URL"
          placeholder="https://example.com or myapp://path"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={props.disabled || !valid}
        >
          Open
        </Button>
      </form>
      {props.feedback}
    </DrawerSection>
  );
}

/**
 * Everything that names an app: launch, terminate, a permission decision and
 * (iOS) a push. One app id field feeds them all, since they are usually about
 * the app under test.
 */
function AppsSection(props: {
  readonly platform: SimulatorPlatform;
  readonly disabled: boolean;
  readonly feedback: (key: ControlKey) => ReactNode;
  readonly onSend: (action: SimulatorAction) => void;
}) {
  const { platform, disabled, feedback, onSend } = props;
  const [appId, setAppId] = useState("");
  const [permission, setPermission] = useState<SimulatorPermission>("camera");
  const [pushMessage, setPushMessage] = useState("");
  const id = appId.trim();
  const idValid = APP_ID_PATTERN.test(id);
  const can = (type: Exclude<SimulatorAction["type"], "setToggle">) =>
    simulatorSupportsAction(platform, { type });
  const showLaunch = can("launchApp") || can("terminateApp");
  if (!showLaunch && !can("setPermission") && !can("sendPush")) return null;
  const blocked = disabled || !idValid;
  return (
    <DrawerSection title="Apps">
      <Input
        size="sm"
        aria-label={platform === "ios" ? "Bundle ID" : "Package name"}
        placeholder="com.example.app"
        value={appId}
        onChange={(event) => setAppId(event.target.value)}
      />
      {showLaunch ? (
        <div className="flex flex-col gap-1">
          <div className="flex gap-2">
            {can("launchApp") ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={blocked}
                onClick={() => onSend({ type: "launchApp", appId: id })}
              >
                Launch
              </Button>
            ) : null}
            {can("terminateApp") ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={blocked}
                onClick={() => onSend({ type: "terminateApp", appId: id })}
              >
                Terminate
              </Button>
            ) : null}
          </div>
          {feedback("launchApp")}
          {feedback("terminateApp")}
        </div>
      ) : null}
      {can("setPermission") ? (
        <DrawerField label="Permission" feedback={feedback("setPermission")}>
          <Select
            value={permission}
            disabled={disabled}
            onValueChange={(value) => {
              if (isPermission(value)) setPermission(value);
            }}
          >
            <SelectTrigger aria-label="Permission" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PERMISSION_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={blocked}
              onClick={() =>
                onSend({
                  type: "setPermission",
                  appId: id,
                  permission,
                  decision: "grant",
                })
              }
            >
              Grant
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={blocked}
              onClick={() =>
                onSend({
                  type: "setPermission",
                  appId: id,
                  permission,
                  decision: "revoke",
                })
              }
            >
              Revoke
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={blocked}
              onClick={() =>
                onSend({
                  type: "setPermission",
                  appId: id,
                  permission,
                  decision: "reset",
                })
              }
            >
              Reset
            </Button>
          </div>
        </DrawerField>
      ) : null}
      {can("sendPush") ? (
        <DrawerField label="Push notification" feedback={feedback("sendPush")}>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const message = pushMessage.trim();
              if (!blocked && message.length > 0) {
                onSend({ type: "sendPush", appId: id, payload: message });
              }
            }}
          >
            <Input
              size="sm"
              aria-label="Push message"
              placeholder="Message"
              value={pushMessage}
              onChange={(event) => setPushMessage(event.target.value)}
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={blocked || pushMessage.trim().length === 0}
            >
              Send
            </Button>
          </form>
        </DrawerField>
      ) : null}
    </DrawerSection>
  );
}
