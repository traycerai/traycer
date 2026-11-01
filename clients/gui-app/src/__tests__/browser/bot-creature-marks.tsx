import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemberAvatar, NamedBotAvatar } from "@/components/bots/bot-avatars";
import { cn } from "@/lib/utils";
import "@/index.css";

/**
 * THE CREATURE MARKS' CONTACT SHEET: bots by real-shaped ids at every
 * avatar size, beside people in their circles, in colour and
 * in grayscale, under the light theme or with `?theme=dark` the dark one.
 * Every picture is the production `NamedBotAvatar` or `MemberAvatar`.
 *
 * The first three ids are real derived main-bot ids (`bot-avatars.test.tsx`
 * says how): the personal Tracy and two "Team Tracy" bots on one hue in its
 * two tones. "Twin" is on the personal Tracy's swatch exactly, so the sheet
 * shows two bots told apart by the creature alone. The rest are random ids
 * of the same shape.
 *
 * `browser-tests/bot-creature-marks.spec.ts` reads the painted pixels here;
 * the sheet itself is what a person looks at when the generator changes.
 */
const BOTS: ReadonlyArray<{ readonly title: string; readonly botId: string }> =
  [
    { title: "Tracy", botId: "bot_019YFRXBQ551DN29WCTHKM3CEP" },
    { title: "Team Tracy", botId: "bot_0RVWRHPMH8WPT9KW1NGKJB319D" },
    { title: "Team Tracy (S)", botId: "bot_0YVZD4PHYFAZS1MCR0D9GABAGV" },
    { title: "Twin", botId: "bot_0KNEF4PC1F8D0H626S5VEKEQ8Y" },
    { title: "Release", botId: "bot_0HJWG5J1CBMN5G6P2TJKVM1BTC" },
    { title: "QA", botId: "bot_0YNTD7R4TXXMB2NCTCPFWC9DWH" },
    { title: "Docs", botId: "bot_04AVD8GCXRE2WBWS1B5301DZ2Z" },
    { title: "Triage", botId: "bot_0BHAF30C73QHBSQ7G0M8C7W2PR" },
    { title: "Infra", botId: "bot_00RFW54YAGJKVQNHC91DDFA5BD" },
    { title: "Sentry", botId: "bot_0X904A4R0PHHRMZ3V5R55353ZH" },
    { title: "Billing", botId: "bot_0CMZFWFPVBYBD82G65ECDKBFNW" },
    { title: "Mobile", botId: "bot_0C6KRNMMJXMKYDJNMJZ6A69HG3" },
    { title: "Design", botId: "bot_0W3A192PSAEM5HWM63DMA5BZA3" },
    { title: "Growth", botId: "bot_0P29N43B6XR11WNFSZGADWCP6A" },
    { title: "Support", botId: "bot_0BGDC1FH7T377Q9EZGGD54CDWQ" },
    { title: "Security", botId: "bot_0DB521TFEB8RA4NACZ24FHY08M" },
    { title: "Data", botId: "bot_03A5BR35BX9456SDAGY0BNP6WR" },
    { title: "Search", botId: "bot_03RY5HPNJAN11Q7M2RDEKXP2ZX" },
    { title: "Voice", botId: "bot_05XAE6B4E6SRVM2BMBZ34WD52Y" },
    { title: "Slack", botId: "bot_0HG4W993NK3PTMJDTPJVVBS6QJ" },
  ];

const PEOPLE: ReadonlyArray<{
  readonly userId: string;
  readonly name: string;
  readonly avatarUrl: string | null;
}> = [
  {
    userId: "user_tanveer",
    name: "Tanveer Gill",
    avatarUrl:
      "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' fill='%23d9c7b2'/><circle cx='32' cy='24' r='12' fill='%236b4f3a'/><ellipse cx='32' cy='56' rx='20' ry='16' fill='%236b4f3a'/></svg>",
  },
  { userId: "user_simar", name: "Simar Kaur", avatarUrl: null },
];

const SIZES = ["xs", "sm", "default", "lg"] as const;

const theme =
  new URLSearchParams(location.search).get("theme") === "dark"
    ? "dark"
    : "light";
if (theme === "dark") document.documentElement.classList.add("dark");

export function Sheet(props: { readonly grayscale: boolean }): ReactElement {
  const name = props.grayscale ? "grayscale" : "colour";
  return (
    <section
      data-testid={`sheet-${name}`}
      className={cn("flex flex-col gap-3 p-4", props.grayscale && "grayscale")}
    >
      <h2 className="text-ui-sm font-semibold">{`${theme}, ${name}`}</h2>
      {/* Rows of one fixed width and avatars on the row's top edge keep
          every avatar on whole pixels, which the spec checks first. */}
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {BOTS.map((bot) => (
          <div
            key={bot.botId}
            data-testid="sheet-bot"
            data-bot-id={bot.botId}
            className="flex w-72 items-start gap-2"
          >
            {SIZES.map((size) => (
              <NamedBotAvatar key={size} botId={bot.botId} size={size} />
            ))}
            <span className="truncate text-ui-xs">{bot.title}</span>
          </div>
        ))}
        {PEOPLE.map((person) => (
          <div key={person.userId} className="flex w-72 items-start gap-2">
            {SIZES.map((size) => (
              <MemberAvatar
                key={size}
                userId={person.userId}
                name={person.name}
                avatarUrl={person.avatarUrl}
                size={size}
              />
            ))}
            <span className="truncate text-ui-xs">{person.name}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ContactSheet(): ReactElement {
  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <Sheet grayscale={false} />
      <Sheet grayscale />
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("bot-creature-marks: no #root");
createRoot(root).render(<ContactSheet />);
