import { beforeEach, describe, expect, it } from "vitest";
import type { SlackAppView } from "@traycer/protocol/host/slack-app";
import {
  useBotSlackPendingInstallStore,
  type BotSlackPendingInstall,
} from "@/stores/bots/bot-slack-pending-install-store";

const BOT_ID = "bot-1";
const OTHER_BOT_ID = "bot-2";
const NOW = 1_000_000;
const EXPIRES_AT = NOW + 600_000;
const BASELINE = 1_700_000_000_000;

function pending(
  overrides: Partial<BotSlackPendingInstall>,
): BotSlackPendingInstall {
  return {
    botId: BOT_ID,
    expiresAt: EXPIRES_AT,
    baselineInstalledAt: null,
    ...overrides,
  };
}

function appIn(
  installState: SlackAppView["installState"],
  installedAt: number | null,
): SlackAppView {
  return {
    botId: BOT_ID,
    appId: "A07K2M9QX4T",
    clientId: "123.456",
    installState,
    teamId: installState === "registered" ? null : "T01",
    teamName: installState === "registered" ? null : "Acme",
    botUserId: installState === "registered" ? null : "U01",
    installedAt,
  };
}

function isWaiting(botId: string): boolean {
  return Object.hasOwn(
    useBotSlackPendingInstallStore.getState().entries,
    botId,
  );
}

beforeEach(() => {
  useBotSlackPendingInstallStore.setState({ entries: {} });
});

describe("bot Slack pending install store", () => {
  it("keeps waiting while the app is registered", () => {
    const { begin, settle } = useBotSlackPendingInstallStore.getState();
    begin(pending({}));

    settle(BOT_ID, appIn("registered", null), NOW);

    expect(isWaiting(BOT_ID)).toBe(true);
  });

  it("keeps waiting while the app is uninstalled, since consent can still finish", () => {
    const { begin, settle } = useBotSlackPendingInstallStore.getState();
    begin(pending({ baselineInstalledAt: BASELINE }));

    settle(BOT_ID, appIn("uninstalled", BASELINE), NOW);

    expect(isWaiting(BOT_ID)).toBe(true);
  });

  it("stops waiting when the app is installed at a different time than the baseline", () => {
    const { begin, settle } = useBotSlackPendingInstallStore.getState();
    begin(pending({ baselineInstalledAt: BASELINE }));

    settle(BOT_ID, appIn("installed", BASELINE + 5_000), NOW);

    expect(isWaiting(BOT_ID)).toBe(false);
  });

  it("stops waiting when a first install lands against a null baseline", () => {
    const { begin, settle } = useBotSlackPendingInstallStore.getState();
    begin(pending({ baselineInstalledAt: null }));

    settle(BOT_ID, appIn("installed", BASELINE), NOW);

    expect(isWaiting(BOT_ID)).toBe(false);
  });

  it("keeps waiting on an installed app whose installedAt is still the baseline (Install again in flight)", () => {
    const { begin, settle } = useBotSlackPendingInstallStore.getState();
    begin(pending({ baselineInstalledAt: BASELINE }));

    settle(BOT_ID, appIn("installed", BASELINE), NOW);

    expect(isWaiting(BOT_ID)).toBe(true);
  });

  it("stops waiting when the app is gone", () => {
    const { begin, settle } = useBotSlackPendingInstallStore.getState();
    begin(pending({}));

    settle(BOT_ID, null, NOW);

    expect(isWaiting(BOT_ID)).toBe(false);
  });

  it("stops waiting once the URL has expired, even on an app still awaiting consent", () => {
    const { begin, settle } = useBotSlackPendingInstallStore.getState();
    begin(pending({}));

    settle(BOT_ID, appIn("registered", null), EXPIRES_AT);

    expect(isWaiting(BOT_ID)).toBe(false);
  });

  it("settles only the bot it was asked about", () => {
    const { begin, settle } = useBotSlackPendingInstallStore.getState();
    begin(pending({}));
    begin(pending({ botId: OTHER_BOT_ID }));

    settle(BOT_ID, null, NOW);

    expect(isWaiting(BOT_ID)).toBe(false);
    expect(isWaiting(OTHER_BOT_ID)).toBe(true);
  });

  it("ends the wait an expiry belongs to", () => {
    const { begin, expire } = useBotSlackPendingInstallStore.getState();
    begin(pending({}));

    expire(BOT_ID, EXPIRES_AT);

    expect(isWaiting(BOT_ID)).toBe(false);
  });

  it("lets a newer URL's wait survive an older URL's expiry", () => {
    const { begin, expire } = useBotSlackPendingInstallStore.getState();
    begin(pending({ expiresAt: EXPIRES_AT }));
    begin(pending({ expiresAt: EXPIRES_AT + 60_000 }));

    expire(BOT_ID, EXPIRES_AT);

    expect(
      useBotSlackPendingInstallStore.getState().entries[BOT_ID].expiresAt,
    ).toBe(EXPIRES_AT + 60_000);
  });

  it("drops the bot's wait on clear and leaves other bots' alone", () => {
    const { begin, clear } = useBotSlackPendingInstallStore.getState();
    begin(pending({}));
    begin(pending({ botId: OTHER_BOT_ID }));

    clear(BOT_ID);

    expect(isWaiting(BOT_ID)).toBe(false);
    expect(isWaiting(OTHER_BOT_ID)).toBe(true);
  });
});
