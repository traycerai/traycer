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

/**
 * VSCodium's official mark. The gradient id is `useId`-scoped because several
 * of these icons can be mounted at once and a duplicate SVG id would make
 * every instance paint whichever definition rendered last.
 */
export function VSCodiumIcon({ className, ...props }: EditorIconProps) {
  const id = useId();
  const gradientId = `${id}-vscodium-a`;
  // VSCodium's own mark (`icons/stable/codium_cnl.svg` in the VSCodium repo,
  // MIT), with its gradient's `gradientTransform` folded into the stop
  // coordinates so the whole icon lives in one 100x100 user space.
  return (
    <svg {...props} viewBox="0 0 100 100" className={cn(className)}>
      <defs>
        <linearGradient
          id={gradientId}
          x1="-0.003"
          y1="1.302"
          x2="96.665"
          y2="94.573"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#62A0EA" />
          <stop offset="1" stopColor="#1A5FB4" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientId})`}
        d="M48.26,2.274 C45.406,4.105 44.583,7.898 46.422,10.742 C56.531,26.397 58.917,38.205 57.882,48.553 C53.698,68.369 44.603,72.389 36.655,72.389 C28.895,72.389 30.973,59.618 36.806,55.88 C40.288,53.706 44.748,52.293 48.171,52.293 C51.563,52.293 54.313,49.552 54.313,46.17 C54.313,42.787 51.563,40.046 48.171,40.046 C44.173,40.046 40.251,40.886 36.59,42.316 C37.338,38.787 37.614,34.973 36.647,30.919 C35.179,24.763 30.953,18.883 23.615,13.183 C22.33,12.183 20.7,11.734 19.083,11.934 C17.466,12.134 15.995,12.966 14.994,14.248 C12.912,16.918 13.394,20.766 16.072,22.843 C22.05,27.486 24.024,30.923 24.699,33.752 C25.374,36.581 24.831,39.616 23.475,43.786 C21.742,49.406 19.73,54.423 18.848,59.234 C18.414,61.602 18.377,64.179 18.265,66.238 C13.96,62.042 12.275,56.502 12.275,48.407 C12.274,45.025 9.524,42.283 6.133,42.284 C2.744,42.287 -0.002,45.027 -0.003,48.407 C-0.003,59.463 3.23,69.983 11.895,77.001 C19.739,84.474 39.686,81.712 39.686,93.709 C39.686,97.095 44.642,98.743 48.033,98.743 C51.511,98.743 55.888,96.418 55.888,93.709 C55.888,80.097 70.233,71.824 93.848,71.86 C97.24,71.865 99.992,69.126 99.997,65.744 C100.003,62.361 97.259,59.614 93.867,59.608 C92.252,59.606 90.678,59.661 89.126,59.753 C91.766,53.544 92.937,46.708 92.695,39.324 C92.583,35.943 89.745,33.293 86.356,33.403 C82.963,33.513 80.305,36.346 80.416,39.729 C80.736,49.397 80.374,58.03 73.171,62.581 C71.123,63.874 68.742,64.996 66.484,64.996 C68.237,60.228 69.561,55.195 70.103,49.77 C70.449,46.308 70.486,42.195 70.091,39 C69.478,34.05 68.738,28.436 70.617,24.207 C72.305,20.565 76.087,19.04 81.64,19.04 C85.029,19.037 87.775,16.296 87.776,12.917 C87.778,9.534 85.031,6.79 81.64,6.787 C73.388,6.787 67.133,11.13 63.587,16.377 C61.733,12.417 59.475,8.336 56.747,4.112 C55.866,2.747 54.478,1.788 52.887,1.443 C52.099,1.272 51.285,1.257 50.491,1.399 C49.697,1.542 48.939,1.839 48.26,2.274 z"
      />
    </svg>
  );
}

/**
 * The macOS Finder face: one rounded square split down the middle, the left
 * half blue and the right half near-white, with the smile crossing both. The
 * smile is stroked twice under per-half clips because a single colour is
 * invisible on one side or the other; ids are `useId`-scoped so several
 * instances cannot collide on them. Kept to flat shapes so the split still
 * reads at 14px.
 */
export function FinderIcon({ className, ...props }: EditorIconProps) {
  const id = useId();
  const squareId = `${id}-finder-a`;
  const leftId = `${id}-finder-b`;
  const rightId = `${id}-finder-c`;
  return (
    <svg {...props} viewBox="0 0 24 24" className={cn(className)}>
      <defs>
        <clipPath id={squareId}>
          <rect x="1" y="1" width="22" height="22" rx="5" />
        </clipPath>
        <clipPath id={leftId}>
          <rect x="1" y="1" width="11" height="22" />
        </clipPath>
        <clipPath id={rightId}>
          <rect x="12" y="1" width="11" height="22" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${squareId})`}>
        <rect x="1" y="1" width="11" height="22" fill="#2E8BF2" />
        <rect x="12" y="1" width="11" height="22" fill="#EDF4FE" />
        <ellipse cx="7.4" cy="9" rx="1.05" ry="1.7" fill="#FFFFFF" />
        <ellipse cx="16.6" cy="9" rx="1.05" ry="1.7" fill="#31415C" />
        <g clipPath={`url(#${leftId})`}>
          <path
            d="M6 13.7c1.55 2.7 3.65 4.05 6 4.05s4.45-1.35 6-4.05"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </g>
        <g clipPath={`url(#${rightId})`}>
          <path
            d="M6 13.7c1.55 2.7 3.65 4.05 6 4.05s4.45-1.35 6-4.05"
            fill="none"
            stroke="#31415C"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </g>
      </g>
      <rect
        x="1"
        y="1"
        width="22"
        height="22"
        rx="5"
        fill="none"
        stroke="#31415C"
        strokeOpacity="0.22"
      />
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
