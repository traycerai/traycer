import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch";
import { zoomInstanceTo } from "../zoom-instance-to";

afterEach(cleanup);

const cases = [
  {
    name: "far edge",
    expectedX: -500,
    position: -1500,
    target: 1,
    center: false,
    padding: false,
    limited: true,
  },
  {
    name: "near edge",
    expectedX: 0,
    position: 0,
    target: 1,
    center: false,
    padding: false,
    limited: true,
  },
  {
    name: "interior anchor",
    expectedX: -500,
    position: -750,
    target: 1.5,
    center: false,
    padding: false,
    limited: true,
  },
  {
    name: "content fits",
    expectedX: 31.25,
    position: -1500,
    target: 0.25,
    center: false,
    padding: false,
    limited: true,
  },
  {
    name: "center fitted content",
    expectedX: 125,
    position: -1500,
    target: 0.25,
    center: true,
    padding: false,
    limited: true,
  },
  {
    name: "fit without padding",
    expectedX: 0,
    position: -1500,
    target: 0.25,
    center: false,
    padding: true,
    limited: true,
  },
  {
    name: "unbounded viewer",
    expectedX: -625,
    position: -1500,
    target: 1,
    center: false,
    padding: false,
    limited: false,
  },
  {
    name: "zoom in",
    expectedX: -1250,
    position: -750,
    target: 3,
    center: false,
    padding: false,
    limited: true,
  },
];

it.each(
  cases.flatMap((test) => [true, false].map((smooth) => ({ ...test, smooth }))),
)(
  "matches the installed button path: $name (smooth=$smooth)",
  ({ position, target, center, padding, limited, smooth, expectedX }) => {
    const ref = createRef<ReactZoomPanPinchRef>();
    render(
      <TransformWrapper
        ref={ref}
        minScale={0.1}
        maxScale={8}
        smooth={smooth}
        centerZoomedOut={center}
        disablePadding={padding}
        limitToBounds={limited}
      >
        <TransformComponent>
          <div>synthetic image</div>
        </TransformComponent>
      </TransformWrapper>,
    );
    const api = ref.current;
    if (api === null) throw new Error("Viewer did not initialize");
    const wrapper = api.instance.wrapperComponent;
    const content = api.instance.contentComponent;
    if (wrapper === null || content === null)
      throw new Error("Viewer did not mount");
    Object.defineProperties(wrapper, {
      clientWidth: { value: 500 },
      clientHeight: { value: 500 },
      offsetWidth: { value: 500 },
      offsetHeight: { value: 500 },
    });
    Object.defineProperties(content, {
      offsetWidth: { value: 1000 },
      offsetHeight: { value: 1000 },
    });
    act(() => {
      api.setTransform(position, position, 2, 0);
      if (target > 2) api.zoomIn(smooth ? Math.log(target / 2) : target - 2, 0);
      else api.zoomOut(smooth ? Math.log(2 / target) : 2 - target, 0);
    });
    const expected = { ...api.instance.state };
    act(() => {
      api.setTransform(position, position, 2, 0);
      zoomInstanceTo(api, target, 0);
    });
    expect(api.instance.state.scale).toBe(target);
    expect(api.instance.state.scale).toBe(expected.scale);
    expect(api.instance.state.positionX).toBeCloseTo(expectedX, 2);
    expect(api.instance.state.positionX).toBeCloseTo(expected.positionX, 2);
    expect(api.instance.state.positionY).toBeCloseTo(expected.positionY, 2);
    if (position === -1500 && target === 1 && limited) {
      expect(api.instance.state.positionX).toBe(-500);
    }
  },
);
