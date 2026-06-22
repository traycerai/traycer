import { useId } from "react";
import gradientBg from "@/assets/brand/gradient-bg.jpg";

/**
 * Shared cinematic photo backdrop for the signed-out surfaces (auth landing
 * and first-launch onboarding). Two stacked copies of the brand gradient
 * photo - a dimmed full-bleed base plus a brighter masked bloom rising from
 * the bottom - under a black contrast wash.
 */
export function PhotoBloom() {
  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
      <img
        src={gradientBg}
        alt=""
        className="absolute inset-0 h-full w-full object-cover object-top opacity-90 brightness-[0.28] contrast-[1.26] saturate-[0.95]"
      />
      <div className="absolute inset-x-0 bottom-0 h-[74svh] overflow-hidden [mask-image:linear-gradient(to_bottom,transparent_0%,rgba(0,0,0,0.4)_22%,black_42%,black_100%)]">
        <img
          src={gradientBg}
          alt=""
          className="absolute left-1/2 top-0 h-[145%] w-[138%] max-w-none -translate-x-[41%] object-cover object-top opacity-100 brightness-[0.68] contrast-[1.16] saturate-[1.04]"
        />
      </div>
      <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(0,0,0,0.8)_0%,rgba(0,0,0,0.86)_36%,rgba(0,0,0,0.66)_55%,rgba(0,0,0,0.18)_82%,rgba(0,0,0,0.38)_100%)]" />
    </div>
  );
}

interface BrandMarkProps {
  readonly className: string;
}

export function BrandMark(props: BrandMarkProps) {
  // Unique per instance so multiple BrandMarks in one document can't collide
  // on the SVG mask id.
  const maskId = `auth-traycer-mark-mask-${useId().replace(/:/g, "")}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 211 218"
      fill="none"
      className={props.className}
      aria-hidden="true"
      focusable="false"
    >
      <mask
        id={maskId}
        width="211"
        height="218"
        x="0"
        y="0"
        maskUnits="userSpaceOnUse"
      >
        <path fill="#fff" d="M0 .788h210.93v216.789H0V.787Z" />
      </mask>
      <g mask={`url(#${maskId})`}>
        <path
          fill="#fff"
          fillRule="evenodd"
          d="m42.181 178.442 2.409 2.427.233.24c7.46 7.952 7.39 20.732-.233 28.564-7.623 7.832-20.062 7.904-27.802.24l-.233-.24-2.409-2.45-6.523-6.727c-7.693-7.904-7.693-20.853 0-28.804 7.692-7.904 20.342-7.904 28.035 0l6.523 6.75ZM174.384 67.021l2.338-2.379 27.1-27.843c7.693-7.928 7.693-20.877 0-28.804-7.74-7.928-20.343-7.928-28.035 0l-29.415 30.221-14.029 14.39c-7.693 7.928-7.693 20.877 0 28.805l14.029 14.39 2.502 2.546 27.1 27.844c7.692 7.928 20.295 7.928 28.035 0 7.693-7.904 7.693-20.877 0-28.78l-27.1-27.844-2.525-2.546ZM8.744 8.187v-.024c7.694-7.928 20.32-7.928 28.036 0l166.855 171.456c7.716 7.904 7.716 20.877 0 28.781a19.496 19.496 0 0 1-28.035 0L8.745 36.943c-7.693-7.904-7.693-20.852 0-28.756Zm-.233 82.065c7.693-7.904 20.296-7.904 28.035 0l18.986 19.531 68.206 70.077c7.716 7.903 7.716 20.876 0 28.804a19.537 19.537 0 0 1-28.035 0l-27.077-27.843-60.115-61.765c-7.716-7.904-7.716-20.9 0-28.804Z"
          clipRule="evenodd"
        />
      </g>
    </svg>
  );
}
