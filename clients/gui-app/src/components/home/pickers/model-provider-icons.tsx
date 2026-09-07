import { createElement, type ReactElement, type SVGProps } from "react";
import { Sparkles } from "lucide-react";
import Ai302Mono from "@lobehub/icons/es/Ai302/components/Mono";
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
import ClineMono from "@lobehub/icons/es/Cline/components/Mono";
import IbmMono from "@lobehub/icons/es/IBM/components/Mono";
import KiloCodeMono from "@lobehub/icons/es/KiloCode/components/Mono";
import KimiMono from "@lobehub/icons/es/Kimi/components/Mono";
import QiniuMono from "@lobehub/icons/es/Qiniu/components/Mono";
import SiliconCloudMono from "@lobehub/icons/es/SiliconCloud/components/Mono";
import SnowflakeMono from "@lobehub/icons/es/Snowflake/components/Mono";
import TencentMono from "@lobehub/icons/es/Tencent/components/Mono";
import TogetherMono from "@lobehub/icons/es/Together/components/Mono";
import XiaomiMiMoMono from "@lobehub/icons/es/XiaomiMiMo/components/Mono";
import ZhipuMono from "@lobehub/icons/es/Zhipu/components/Mono";
import ZenMuxMono from "@lobehub/icons/es/ZenMux/components/Mono";

/** Coverage is 84 of the catalog's 183 ids, checked against the real `models.dev` payload rather than guessed -
 * every key below is an id the catalog actually ships, so none of them is a mark that can never match. */
export type ModelProviderIcon = (
  props: SVGProps<SVGSVGElement>,
) => ReactElement;

/** The bug it must not inherit is a different thing wearing the same pixels. */
export const GenericModelProviderIcon: ModelProviderIcon = (props) => (
  <Sparkles {...props} />
);

/** Several ids are plan or region variants of one brand and map to the same mark - `alibaba-coding-plan` is
 * Alibaba's billing arrangement, not a different company. */
const MODEL_PROVIDER_ICONS: Readonly<Record<string, ModelProviderIcon>> = {
  "302ai": (props) => <Ai302Mono {...props} />,
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
  // Anthropic's models served through Vertex. The row names the gateway, and the gateway is what the credential
  // belongs to.
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
  // It pointed at Zhipu's, which is the parent company rather than the brand this row names - and it broke the
  // rule stated above it, where every plan variant wears its parent's mark.
  "zai-coding-plan": (props) => <ZAIMono {...props} />,
  "cline-pass": (props) => <ClineMono {...props} />,
  kilo: (props) => <KiloCodeMono {...props} />,
  "kimi-for-coding": (props) => <KimiMono {...props} />,
  "opencode-go": (props) => <OpenCodeMono {...props} />,
  "perplexity-agent": (props) => <PerplexityMono {...props} />,
  "qiniu-ai": (props) => <QiniuMono {...props} />,
  siliconflow: (props) => <SiliconCloudMono {...props} />,
  "siliconflow-cn": (props) => <SiliconCloudMono {...props} />,
  "snowflake-cortex": (props) => <SnowflakeMono {...props} />,
  "stepfun-ai": (props) => <StepfunMono {...props} />,
  "stepfun-ai-step-plan": (props) => <StepfunMono {...props} />,
  "stepfun-step-plan": (props) => <StepfunMono {...props} />,
  "tencent-coding-plan": (props) => <TencentMono {...props} />,
  "tencent-token-plan": (props) => <TencentMono {...props} />,
  "tencent-tokenhub": (props) => <TencentMono {...props} />,
  togetherai: (props) => <TogetherMono {...props} />,
  watsonx: (props) => <IbmMono {...props} />,
  xiaomi: (props) => <XiaomiMiMoMono {...props} />,
  "xiaomi-token-plan-ams": (props) => <XiaomiMiMoMono {...props} />,
  "xiaomi-token-plan-cn": (props) => <XiaomiMiMoMono {...props} />,
  "xiaomi-token-plan-sgp": (props) => <XiaomiMiMoMono {...props} />,
  zhipuai: (props) => <ZhipuMono {...props} />,
  "zhipuai-coding-plan": (props) => <ZhipuMono {...props} />,
  zenmux: (props) => <ZenMuxMono {...props} />,
};

/** A component rather than a `getIcon(id)` helper the caller renders. */
type MarkProps = SVGProps<SVGSVGElement> & {
  readonly "data-model-provider-icon": string;
};

export function ModelProviderMark(
  props: {
    readonly id: string;
    /** Not derivable from the id, and that is the whole point. */
    readonly configDeclaredCustom: boolean;
  } & SVGProps<SVGSVGElement>,
): ReactElement {
  const { id, configDeclaredCustom, ...rest } = props;
  const known =
    !configDeclaredCustom && Object.hasOwn(MODEL_PROVIDER_ICONS, id);
  const icon = known ? MODEL_PROVIDER_ICONS[id] : GenericModelProviderIcon;
  // Assigned to a typed const first: an object literal at the call site would trip excess-property checking
  // against the icon's `SVGProps`, and the data attribute is the whole point of this indirection.
  const iconProps: MarkProps = {
    ...rest,
    "data-model-provider-icon": known ? id : "generic",
  };
  return createElement(icon, iconProps);
}
