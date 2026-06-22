import { useId } from "react";
import { cn } from "@/lib/utils";

export interface EditorIconProps {
  readonly className: string | undefined;
  readonly "aria-hidden": boolean | "true" | "false" | undefined;
}

export function VisualStudioCodeIcon({ className, ...props }: EditorIconProps) {
  const id = useId();
  const maskId = `${id}-vscode-a`;
  const topShadowFilterId = `${id}-vscode-b`;
  const sideShadowFilterId = `${id}-vscode-c`;
  const overlayGradientId = `${id}-vscode-d`;

  return (
    <svg {...props} fill="none" viewBox="0 0 100 100" className={cn(className)}>
      <mask
        id={maskId}
        width="100"
        height="100"
        x="0"
        y="0"
        maskUnits="userSpaceOnUse"
      >
        <path
          fill="#fff"
          fillRule="evenodd"
          d="M70.91 99.32a6.22 6.22 0 0 0 4.96-.19l20.59-9.91A6.25 6.25 0 0 0 100 83.59V16.41a6.25 6.25 0 0 0-3.54-5.63L75.87.874a6.23 6.23 0 0 0-7.1 1.21L29.36 38.04 12.19 25.01a4.16 4.16 0 0 0-5.32.236l-5.51 5.01a4.17 4.17 0 0 0-.004 6.16L16.25 50 1.36 63.58a4.17 4.17 0 0 0 .004 6.16l5.51 5.01a4.16 4.16 0 0 0 5.32.236l17.17-13.03L68.77 97.92a6.22 6.22 0 0 0 2.14 1.4ZM75.02 27.3 45.11 50l29.91 22.7V27.3Z"
          clipRule="evenodd"
        />
      </mask>
      <g mask={`url(#${maskId})`}>
        <path
          fill="#0065A9"
          d="M96.46 10.8 75.86.876a6.23 6.23 0 0 0-7.11 1.21l-67.45 61.5a4.17 4.17 0 0 0 .004 6.16l5.51 5.01a4.17 4.17 0 0 0 5.32.236l81.23-61.62c2.73-2.07 6.64-.124 6.64 3.3v-.24a6.25 6.25 0 0 0-3.54-5.63Z"
        />
        <g filter={`url(#${topShadowFilterId})`}>
          <path
            fill="#007ACC"
            d="m96.46 89.2-20.6 9.92a6.23 6.23 0 0 1-7.11-1.21l-67.45-61.5a4.17 4.17 0 0 1 .004-6.16l5.51-5.01a4.17 4.17 0 0 1 5.32-.236l81.23 61.62c2.73 2.07 6.64.124 6.64-3.3v.24a6.25 6.25 0 0 1-3.54 5.63Z"
          />
        </g>
        <g filter={`url(#${sideShadowFilterId})`}>
          <path
            fill="#1F9CF0"
            d="M75.86 99.13a6.23 6.23 0 0 1-7.11-1.21c2.31 2.31 6.25.674 6.25-2.59V4.67c0-3.26-3.94-4.89-6.25-2.59a6.23 6.23 0 0 1 7.11-1.21l20.6 9.91A6.25 6.25 0 0 1 100 16.41v67.17a6.25 6.25 0 0 1-3.54 5.63l-20.6 9.91Z"
          />
        </g>
        <path
          fill={`url(#${overlayGradientId})`}
          fillRule="evenodd"
          d="M70.85 99.32a6.22 6.22 0 0 0 4.96-.19L96.4 89.22a6.25 6.25 0 0 0 3.54-5.63V16.41a6.25 6.25 0 0 0-3.54-5.63L75.81.874a6.23 6.23 0 0 0-7.1 1.21L29.29 38.04 12.13 25.01a4.16 4.16 0 0 0-5.32.236l-5.51 5.01a4.17 4.17 0 0 0-.004 6.16L16.19 50 1.3 63.58a4.17 4.17 0 0 0 .004 6.16l5.51 5.01a4.16 4.16 0 0 0 5.32.236L29.29 61.96l39.41 35.96a6.22 6.22 0 0 0 2.14 1.4ZM74.95 27.3 45.05 50l29.91 22.7V27.3Z"
          clipRule="evenodd"
          opacity=".25"
          style={{ mixBlendMode: "overlay" }}
        />
      </g>
      <defs>
        <filter
          id={topShadowFilterId}
          width="116.727"
          height="92.246"
          x="-8.394"
          y="15.829"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
          />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend
            in2="BackgroundImageFix"
            mode="overlay"
            result="effect1_dropShadow"
          />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <filter
          id={sideShadowFilterId}
          width="47.917"
          height="116.151"
          x="60.417"
          y="-8.076"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
          />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend
            in2="BackgroundImageFix"
            mode="overlay"
            result="effect1_dropShadow"
          />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <linearGradient
          id={overlayGradientId}
          x1="49.939"
          x2="49.939"
          y1=".258"
          y2="99.742"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function CursorIcon({ className, ...props }: EditorIconProps) {
  return (
    <svg
      {...props}
      viewBox="0 0 466.73 532.09"
      className={cn("fill-[#26251E] dark:fill-[#EDECEC]", className)}
    >
      <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
    </svg>
  );
}

export function WindsurfIcon({ className, ...props }: EditorIconProps) {
  return (
    <svg
      {...props}
      viewBox="0 0 512 297"
      fill="none"
      className={cn("fill-[#0B100F] dark:fill-[#F0F0F0]", className)}
    >
      <path d="M507.28 0.14H502.4C476.72 0.1 455.88 20.9 455.88 46.57V150.42C455.88 171.15 438.74 187.95 418.34 187.95C406.22 187.95 394.13 181.85 386.94 171.61L280.89 20.14C272.09 7.56 257.77 0.06 242.27 0.06C218.09 0.06 196.33 20.62 196.33 45.99V150.44C196.33 171.17 179.33 187.97 158.79 187.97C146.63 187.97 134.56 181.87 127.38 171.63L8.7 2.12C6.02 -1.72 0 0.18 0 4.86V95.43C0 100 1.4 104.44 4.02 108.2L120.81 275C127.72 284.85 137.9 292.17 149.63 294.83C179.01 301.51 206.05 278.89 206.05 250.08V145.7C206.05 124.96 222.85 108.16 243.59 108.16H243.65C256.15 108.16 267.87 114.26 275.05 124.5L381.13 275.95C389.94 288.55 403.52 296.03 419.72 296.03C444.44 296.03 465.62 275.45 465.62 250.1V145.68C465.62 124.94 482.42 108.14 503.16 108.14H507.3C509.9 108.14 512 106.04 512 103.44V4.84C512 2.24 509.9 0.14 507.3 0.14H507.28Z" />
    </svg>
  );
}

export function ZedIcon({ className, ...props }: EditorIconProps) {
  return (
    <svg
      {...props}
      viewBox="0 0 24 24"
      className={cn("fill-[#0E0F1B] dark:fill-[#F0F0F0]", className)}
    >
      <path d="M2.25 1.5a.75.75 0 0 0-.75.75v16.5H0V2.25A2.25 2.25 0 0 1 2.25 0h20.09c1 0 1.5 1.21.795 1.92L10.76 14.3h3.49V12.75h1.5v1.92a1.13 1.13 0 0 1-1.13 1.13H9.26l-2.58 2.58h11.69V9h1.5v9.38a1.5 1.5 0 0 1-1.5 1.5H5.18L2.56 22.5H21.75a.75.75 0 0 0 .75-.75V5.25H24v16.5A2.25 2.25 0 0 1 21.75 24H1.66C.653 24 .151 22.79.86 22.08L13.19 9.75H9.75v1.5h-1.5V9.38A1.13 1.13 0 0 1 9.38 8.25h5.31l2.63-2.63H5.63V15h-1.5V5.63a1.5 1.5 0 0 1 1.5-1.5h13.19L21.44 1.5z" />
    </svg>
  );
}
