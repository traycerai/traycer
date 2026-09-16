import { useEffect, useRef, useState } from "react";

/* The atmosphere behind the welcome screen and the tour: a slow noise field
   quantised through an ordered dither into a grid of dots, in the theme's own
   colours. It is the static dot grid brought to life, so it is deliberately
   quiet - the brand mark and the copy have to stay dominant.

   No dependency and no framebuffer plumbing: one full-screen triangle, one
   fragment shader, and a handful of uniforms the effect keeps current. */

/** CSS pixels per dot cell at DPR 1. */
const CELL_CSS_PX = 6;
/** Above 1.5 the extra dots are invisible and the fill rate is not. */
const MAX_DEVICE_PIXEL_RATIO = 1.5;

const FIELD_VERTEX_SHADER = `
attribute vec2 aCorner;
void main() {
  gl_Position = vec4(aCorner, 0.0, 1.0);
}
`;

const FIELD_FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 uResolution;
uniform float uTime;
uniform float uCell;
uniform vec3 uPrimary;
uniform vec3 uForeground;

/* Alpha of the brightest dot. The page's copy sits on top of this. */
const float PEAK_ALPHA = 0.35;
/* Dither steps: four gives five levels, which is what reads as a grid rather
   than a gradient. */
const float LEVELS = 4.0;
/* Noise units per second. One unit is a whole blob, so the field turns over
   across roughly half a minute. */
const float DRIFT = 0.04;
/* Cells per noise unit - how large a blob is. Large enough that the field
   reads as one slow form, not a scatter of clouds. */
const float BLOB_CELLS = 24.0;
/* Widest dot, as a share of its cell. */
const float DOT_RADIUS = 0.42;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float valueNoise(vec2 p) {
  vec2 corner = floor(p);
  vec2 f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  float a = hash(corner);
  float b = hash(corner + vec2(1.0, 0.0));
  float c = hash(corner + vec2(0.0, 1.0));
  float d = hash(corner + vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

/* Three octaves over a domain the first one warps: the warp is what keeps the
   flow from reading as a scrolling texture. */
float field(vec2 p) {
  float t = uTime * DRIFT;
  vec2 warp = vec2(
    valueNoise(p + vec2(0.0, t)),
    valueNoise(p.yx + vec2(t, 4.7))
  );
  vec2 q = p + (warp - 0.5) * 0.9;
  return valueNoise(q) * 0.58
    + valueNoise(q * 2.1 + 13.0) * 0.30
    + valueNoise(q * 4.3 + 31.0) * 0.12;
}

/* The 2x2 Bayer matrix in closed form, nested once for 4x4. Folded into the
   first tile first, so the squared term never grows past float precision. */
float bayer2(vec2 p) {
  vec2 c = floor(p);
  return fract(c.x * 0.5 + c.y * c.y * 0.75);
}
float bayer4(vec2 p) {
  vec2 c = mod(floor(p), 4.0);
  return bayer2(c * 0.5) * 0.25 + bayer2(c);
}

void main() {
  vec2 cellIndex = floor(gl_FragCoord.xy / uCell);
  vec2 cellCenter = (cellIndex + 0.5) * uCell;
  vec2 uv = cellCenter / uResolution;

  /* A wide smoothstep rather than an ellipse: the field has to thin out into
     nothing well before any edge, with no rim anywhere. Distance is measured
     in a square space so a wide window fades before its sides. gl_FragCoord
     counts up from the bottom, so 0.58 here is the brand mark's 42% from the
     top. */
  vec2 centred = (uv - vec2(0.5, 0.58)) * vec2(uResolution.x / uResolution.y, 1.0);
  float fade = 1.0 - smoothstep(0.0, 0.62, length(centred));

  /* The raw noise clusters around the middle. Stretching it is what gives the
     field open space to flow through instead of an even wash of dots. The
     fade also lifts the noise, so the middle always carries some field and
     the composition never depends on where the noise happens to peak. */
  float level = smoothstep(0.30, 0.88, field(cellIndex / BLOB_CELLS) + 0.22 * fade) * fade;
  float lit = clamp(floor(level * LEVELS + bayer4(cellIndex)) / LEVELS, 0.0, 1.0);

  float radius = uCell * DOT_RADIUS * lit;
  float edge = length(gl_FragCoord.xy - cellCenter);
  float ink = 1.0 - smoothstep(radius - 1.0, radius + 1.0, edge);

  /* Keep the accent in the brightest dot: a full mix to the foreground would
     wash every theme to grey at the top of the range. */
  vec3 tint = mix(uPrimary, uForeground, 0.2 + 0.4 * lit);
  gl_FragColor = vec4(tint, PEAK_ALPHA * lit * ink);
}
`;

type Rgb = readonly [number, number, number];

const FALLBACK_RGB: Rgb = [0.5, 0.5, 0.5];

/** Resolves any CSS colour the browser can parse - the theme tokens are
 *  `oklch()`, which `getComputedStyle().color` hands back unconverted. A 1x1
 *  2D context is the one readback that is always in sRGB bytes. */
function readColor(probe: CanvasRenderingContext2D | null, value: string): Rgb {
  if (probe === null) return FALLBACK_RGB;
  probe.fillStyle = "#808080";
  // An unparseable value leaves the assignment above standing.
  probe.fillStyle = value.trim();
  probe.fillRect(0, 0, 1, 1);
  const pixel = probe.getImageData(0, 0, 1, 1).data;
  return [pixel[0] / 255, pixel[1] / 255, pixel[2] / 255];
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

function buildProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, FIELD_VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FIELD_FRAGMENT_SHADER);
  if (vertex === null || fragment === null) return null;
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  const linked: unknown = gl.getProgramParameter(program, gl.LINK_STATUS);
  if (linked !== true) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

export function OnboardingField(props: { readonly welcoming: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas === null ? null : canvas.parentElement;
    if (canvas === null || parent === null) return;
    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
    });
    if (gl === null) {
      setSupported(false);
      return;
    }
    const program = buildProgram(gl);
    if (program === null) {
      setSupported(false);
      return;
    }

    // Every pixel belongs to exactly one cell, so nothing overlaps and the
    // canvas never blends against itself - only against the page underneath.
    gl.useProgram(program);
    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const corner = gl.getAttribLocation(program, "aCorner");
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

    const uResolution = gl.getUniformLocation(program, "uResolution");
    const uTime = gl.getUniformLocation(program, "uTime");
    const uCell = gl.getUniformLocation(program, "uCell");
    const uPrimary = gl.getUniformLocation(program, "uPrimary");
    const uForeground = gl.getUniformLocation(program, "uForeground");

    const probe = document
      .createElement("canvas")
      .getContext("2d", { willReadFrequently: true });
    const start = performance.now();
    let elapsed = 0;
    let frame = 0;

    const draw = (): void => {
      gl.uniform1f(uTime, elapsed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio, MAX_DEVICE_PIXEL_RATIO);
      const width = Math.max(1, Math.round(parent.clientWidth * dpr));
      const height = Math.max(1, Math.round(parent.clientHeight * dpr));
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.uniform2f(uResolution, width, height);
      gl.uniform1f(uCell, CELL_CSS_PX * dpr);
      draw();
    };

    const recolor = (): void => {
      const root = getComputedStyle(document.documentElement);
      const primary = readColor(probe, root.getPropertyValue("--primary"));
      const foreground = readColor(
        probe,
        root.getPropertyValue("--foreground"),
      );
      gl.uniform3f(uPrimary, primary[0], primary[1], primary[2]);
      gl.uniform3f(uForeground, foreground[0], foreground[1], foreground[2]);
      draw();
    };

    const loop = (now: number): void => {
      elapsed = (now - start) / 1000;
      draw();
      frame = window.requestAnimationFrame(loop);
    };

    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    // Paused states still get their one frame: the field is always present,
    // it just stops moving.
    const play = (): void => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      frame = 0;
      if (still.matches || document.hidden) {
        draw();
        return;
      }
      frame = window.requestAnimationFrame(loop);
    };

    recolor();
    resize();
    play();

    const theme = new MutationObserver(recolor);
    theme.observe(document.documentElement, {
      attributeFilter: ["class", "data-theme"],
    });
    const box = new ResizeObserver(resize);
    box.observe(parent);
    document.addEventListener("visibilitychange", play);
    still.addEventListener("change", play);

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      theme.disconnect();
      box.disconnect();
      document.removeEventListener("visibilitychange", play);
      still.removeEventListener("change", play);
      gl.deleteProgram(program);
      gl.deleteBuffer(corners);
      // Deliberately no loseContext(): React's dev double-mount re-runs this
      // effect on the same canvas, and a lost context hands back null shaders,
      // which reads as "no WebGL" and strands the page on the static grid.
      // The canvas leaves the DOM on unmount and takes its context with it.
    };
  }, []);

  if (!supported)
    return (
      <div
        aria-hidden="true"
        className="onboarding-dot-grid pointer-events-none absolute inset-0"
      />
    );
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-welcoming={props.welcoming}
      // A canvas is a replaced element: absolutely positioned with auto width it
      // takes its backing-store size, not its container, so size it explicitly.
      className="onboarding-field pointer-events-none absolute inset-0 size-full"
    />
  );
}
