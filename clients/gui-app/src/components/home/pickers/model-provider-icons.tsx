import { createElement, type ReactElement, type SVGProps } from "react";
import { Boxes } from "lucide-react";
import AiHubMixMono from "@lobehub/icons/es/AiHubMix/components/Mono";
import AlibabaMono from "@lobehub/icons/es/Alibaba/components/Mono";
import AnthropicMono from "@lobehub/icons/es/Anthropic/components/Mono";
import AzureMono from "@lobehub/icons/es/Azure/components/Mono";
import BasetenMono from "@lobehub/icons/es/Baseten/components/Mono";
import BedrockMono from "@lobehub/icons/es/Bedrock/components/Mono";
import CerebrasMono from "@lobehub/icons/es/Cerebras/components/Mono";
import CloudflareMono from "@lobehub/icons/es/Cloudflare/components/Mono";
import CohereMono from "@lobehub/icons/es/Cohere/components/Mono";
import DeepInfraMono from "@lobehub/icons/es/DeepInfra/components/Mono";
import DeepSeekMono from "@lobehub/icons/es/DeepSeek/components/Mono";
import FireworksMono from "@lobehub/icons/es/Fireworks/components/Mono";
import FriendliMono from "@lobehub/icons/es/Friendli/components/Mono";
import GithubCopilotMono from "@lobehub/icons/es/GithubCopilot/components/Mono";
import GoogleMono from "@lobehub/icons/es/Google/components/Mono";
import GroqMono from "@lobehub/icons/es/Groq/components/Mono";
import HuggingFaceMono from "@lobehub/icons/es/HuggingFace/components/Mono";
import InceptionMono from "@lobehub/icons/es/Inception/components/Mono";
import InferenceMono from "@lobehub/icons/es/Inference/components/Mono";
import LmStudioMono from "@lobehub/icons/es/LmStudio/components/Mono";
import LongCatMono from "@lobehub/icons/es/LongCat/components/Mono";
import MetaMono from "@lobehub/icons/es/Meta/components/Mono";
import MinimaxMono from "@lobehub/icons/es/Minimax/components/Mono";
import MistralMono from "@lobehub/icons/es/Mistral/components/Mono";
import ModelScopeMono from "@lobehub/icons/es/ModelScope/components/Mono";
import MoonshotMono from "@lobehub/icons/es/Moonshot/components/Mono";
import MorphMono from "@lobehub/icons/es/Morph/components/Mono";
import NebiusMono from "@lobehub/icons/es/Nebius/components/Mono";
import NovaMono from "@lobehub/icons/es/Nova/components/Mono";
import NvidiaMono from "@lobehub/icons/es/Nvidia/components/Mono";
import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono";
import OpenCodeMono from "@lobehub/icons/es/OpenCode/components/Mono";
import OpenRouterMono from "@lobehub/icons/es/OpenRouter/components/Mono";
import PerplexityMono from "@lobehub/icons/es/Perplexity/components/Mono";
import PoeMono from "@lobehub/icons/es/Poe/components/Mono";
import PoolsideMono from "@lobehub/icons/es/Poolside/components/Mono";
import StepfunMono from "@lobehub/icons/es/Stepfun/components/Mono";
import SubModelMono from "@lobehub/icons/es/SubModel/components/Mono";
import UpstageMono from "@lobehub/icons/es/Upstage/components/Mono";
import V0Mono from "@lobehub/icons/es/V0/components/Mono";
import VeniceMono from "@lobehub/icons/es/Venice/components/Mono";
import VercelMono from "@lobehub/icons/es/Vercel/components/Mono";
import VertexAIMono from "@lobehub/icons/es/VertexAI/components/Mono";
import XAIMono from "@lobehub/icons/es/XAI/components/Mono";
import ZAIMono from "@lobehub/icons/es/ZAI/components/Mono";
import ZenMuxMono from "@lobehub/icons/es/ZenMux/components/Mono";
import ZhipuMono from "@lobehub/icons/es/Zhipu/components/Mono";

/**
 * Brand marks for the UPSTREAM model providers a harness can call - the
 * `models.dev` catalog behind OpenCode's `/provider` list, ~180 ids.
 *
 * Same source as `harness-icons.tsx` (`@lobehub/icons`, MIT, per-leaf imports so
 * unused brands tree-shake) and the same legal footing: a mark used to identify
 * the thing it names is nominative fair use, which is what a provider picker is.
 *
 * HAND-OWNED, deliberately. Upstream fetches `models.dev/logos/{id}.svg` at
 * build time and compiles a sprite, which buys them coverage and costs them two
 * bugs we are not copying:
 *
 *  1. That endpoint answers 200 for ANY id, serving a generic sparkles glyph -
 *     so their build cannot tell a hit from a miss, and 14 of their 98 sprite
 *     entries are the fallback wearing a real provider's name. Ours resolves to
 *     {@link GenericModelProviderIcon}, which is not any brand's mark.
 *  2. Their generated name list is not derived from the generated sprite, so
 *     `llmgateway` is declared, absent, and renders as nothing at all - an
 *     invisible icon rather than a fallback. A map whose values are imported
 *     components cannot drift that way: a missing one is a compile error.
 *
 * Coverage is the popular HEAD of the catalog, not all of it. The tail falls
 * back, which is the honest outcome - `@lobehub/icons` has no mark for most of
 * those, and inventing one would be the impersonation bug in a different coat.
 */
export type ModelProviderIcon = (
  props: SVGProps<SVGSVGElement>,
) => ReactElement;

/**
 * The fallback, and the one icon here that is NOT a brand.
 *
 * A neutral glyph on purpose. Upstream's stands in for 14 named providers and
 * happens to be Synthetic's real logo, so their unknown-provider case is
 * indistinguishable from that company's row. Anything recognisable would do the
 * same thing to whichever brand owns it.
 */
export const GenericModelProviderIcon: ModelProviderIcon = (props) => (
  <Boxes {...props} />
);

/**
 * models.dev provider id → brand mark.
 *
 * Keys are catalog ids verbatim (`amazon-bedrock`, `google-vertex-anthropic`),
 * because that is what the host sends. Several ids are plan or region variants
 * of one brand and map to the same mark - `alibaba-coding-plan` is Alibaba's
 * billing arrangement, not a different company.
 */
const MODEL_PROVIDER_ICONS: Readonly<Record<string, ModelProviderIcon>> = {
  aihubmix: (props) => <AiHubMixMono {...props} />,
  alibaba: (props) => <AlibabaMono {...props} />,
  "alibaba-cn": (props) => <AlibabaMono {...props} />,
  "alibaba-coding-plan": (props) => <AlibabaMono {...props} />,
  "alibaba-coding-plan-cn": (props) => <AlibabaMono {...props} />,
  "alibaba-token-plan": (props) => <AlibabaMono {...props} />,
  "alibaba-token-plan-cn": (props) => <AlibabaMono {...props} />,
  "amazon-bedrock": (props) => <BedrockMono {...props} />,
  anthropic: (props) => <AnthropicMono {...props} />,
  azure: (props) => <AzureMono {...props} />,
  "azure-cognitive-services": (props) => <AzureMono {...props} />,
  baseten: (props) => <BasetenMono {...props} />,
  cerebras: (props) => <CerebrasMono {...props} />,
  "cloudflare-ai-gateway": (props) => <CloudflareMono {...props} />,
  "cloudflare-workers-ai": (props) => <CloudflareMono {...props} />,
  cohere: (props) => <CohereMono {...props} />,
  deepinfra: (props) => <DeepInfraMono {...props} />,
  deepseek: (props) => <DeepSeekMono {...props} />,
  "fireworks-ai": (props) => <FireworksMono {...props} />,
  friendli: (props) => <FriendliMono {...props} />,
  "github-copilot": (props) => <GithubCopilotMono {...props} />,
  google: (props) => <GoogleMono {...props} />,
  "google-vertex": (props) => <VertexAIMono {...props} />,
  // Anthropic's models SERVED THROUGH Vertex. The row names the gateway, and
  // the gateway is what the credential belongs to.
  "google-vertex-anthropic": (props) => <VertexAIMono {...props} />,
  groq: (props) => <GroqMono {...props} />,
  huggingface: (props) => <HuggingFaceMono {...props} />,
  inception: (props) => <InceptionMono {...props} />,
  inference: (props) => <InferenceMono {...props} />,
  llama: (props) => <MetaMono {...props} />,
  lmstudio: (props) => <LmStudioMono {...props} />,
  longcat: (props) => <LongCatMono {...props} />,
  meta: (props) => <MetaMono {...props} />,
  minimax: (props) => <MinimaxMono {...props} />,
  "minimax-cn": (props) => <MinimaxMono {...props} />,
  "minimax-coding-plan": (props) => <MinimaxMono {...props} />,
  "minimax-cn-coding-plan": (props) => <MinimaxMono {...props} />,
  mistral: (props) => <MistralMono {...props} />,
  modelscope: (props) => <ModelScopeMono {...props} />,
  moonshotai: (props) => <MoonshotMono {...props} />,
  "moonshotai-cn": (props) => <MoonshotMono {...props} />,
  morph: (props) => <MorphMono {...props} />,
  nebius: (props) => <NebiusMono {...props} />,
  nova: (props) => <NovaMono {...props} />,
  nvidia: (props) => <NvidiaMono {...props} />,
  openai: (props) => <OpenAIMono {...props} />,
  opencode: (props) => <OpenCodeMono {...props} />,
  openrouter: (props) => <OpenRouterMono {...props} />,
  perplexity: (props) => <PerplexityMono {...props} />,
  poe: (props) => <PoeMono {...props} />,
  poolside: (props) => <PoolsideMono {...props} />,
  stepfun: (props) => <StepfunMono {...props} />,
  submodel: (props) => <SubModelMono {...props} />,
  upstage: (props) => <UpstageMono {...props} />,
  v0: (props) => <V0Mono {...props} />,
  venice: (props) => <VeniceMono {...props} />,
  vercel: (props) => <VercelMono {...props} />,
  xai: (props) => <XAIMono {...props} />,
  zai: (props) => <ZAIMono {...props} />,
  "zai-coding-plan": (props) => <ZhipuMono {...props} />,
  zenmux: (props) => <ZenMuxMono {...props} />,
};

/**
 * The mark for a provider id - a brand's, or the neutral one.
 *
 * A COMPONENT rather than a `getIcon(id)` helper the caller renders: resolving
 * a component into a local and rendering `<Icon />` creates a component during
 * render, which remounts the subtree whenever the identity changes and is what
 * `react-hooks`'s rule against it is for. `createElement` off a stable map
 * sidesteps that entirely.
 *
 * NEVER renders nothing. An unknown id, an id we have no mark for, and a custom
 * provider the user declared all get the same neutral glyph - a row with a
 * blank where every sibling has an icon reads as a rendering failure, which is
 * exactly the shape of upstream's `llmgateway` bug.
 *
 * `data-model-provider-icon` names which mark was chosen (the id, or
 * `"generic"`), so a test can tell a brand from the fallback without reaching
 * for component identity.
 */
type MarkProps = SVGProps<SVGSVGElement> & {
  readonly "data-model-provider-icon": string;
};

export function ModelProviderMark(
  props: { readonly id: string } & SVGProps<SVGSVGElement>,
): ReactElement {
  const { id, ...rest } = props;
  const known = Object.hasOwn(MODEL_PROVIDER_ICONS, id);
  const icon = known ? MODEL_PROVIDER_ICONS[id] : GenericModelProviderIcon;
  // Assigned to a typed const first: an object LITERAL at the call site would
  // trip excess-property checking against the icon's `SVGProps`, and the data
  // attribute is the whole point of this indirection.
  const iconProps: MarkProps = {
    ...rest,
    "data-model-provider-icon": known ? id : "generic",
  };
  return createElement(icon, iconProps);
}
