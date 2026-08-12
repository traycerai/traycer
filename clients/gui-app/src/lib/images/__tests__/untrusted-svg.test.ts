import { describe, expect, it } from "vitest";
import { sanitizeUntrustedSvg } from "@/lib/images/untrusted-svg";

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

function svg(body: string, rootAttrs: string): string {
  return `<svg ${SVG_NS} ${rootAttrs}>${body}</svg>`;
}

describe("sanitizeUntrustedSvg malicious fixtures", () => {
  it("rejects script tags", () => {
    expect(() =>
      sanitizeUntrustedSvg(
        svg('<script>alert(1)</script><rect width="10" height="10"/>', ""),
      ),
    ).not.toThrow();
    // DOMPurify strips script; the returned markup must not retain it.
    const cleaned = sanitizeUntrustedSvg(
      svg('<script>alert(1)</script><rect width="10" height="10"/>', ""),
    );
    expect(cleaned.toLowerCase()).not.toContain("<script");
    expect(cleaned.toLowerCase()).not.toContain("alert(1)");
  });

  it("rejects foreignObject", () => {
    const cleaned = sanitizeUntrustedSvg(
      svg(
        '<foreignObject width="100" height="100"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject><circle r="4"/>',
        "",
      ),
    );
    expect(cleaned.toLowerCase()).not.toContain("foreignobject");
  });

  it("rejects style elements", () => {
    const cleaned = sanitizeUntrustedSvg(
      svg(
        '<style>rect{fill:url("https://evil.example/x")}</style><rect width="1" height="1"/>',
        "",
      ),
    );
    expect(cleaned.toLowerCase()).not.toContain("<style");
  });

  it("strips external href and xlink:href", () => {
    // Declare the xlink namespace so DOMParser accepts the attribute; the
    // sanitizer strips any attribute whose localName is `href` (covers both
    // plain href and xlink:href).
    const source = `<svg ${SVG_NS} xmlns:xlink="http://www.w3.org/1999/xlink"><a href="https://evil.example/phish"><text>click</text></a><image xlink:href="https://evil.example/sprite.svg#icon" width="10" height="10"/><image href="https://evil.example/direct.png" width="10" height="10"/></svg>`;
    const cleaned = sanitizeUntrustedSvg(source);
    expect(cleaned).not.toMatch(/https:\/\/evil\.example/i);
    expect(cleaned.toLowerCase()).not.toContain("xlink:href");
    // href attributes (network-capable) must be gone after stripNetworkReferences.
    expect(cleaned).not.toMatch(/\bhref\s*=/i);
  });

  it("strips CSS url() references on attributes", () => {
    const cleaned = sanitizeUntrustedSvg(
      svg(
        '<rect width="10" height="10" fill="url(https://evil.example/f)"/>',
        "",
      ),
    );
    expect(cleaned).not.toMatch(/url\s*\(/i);
    expect(cleaned).not.toMatch(/evil\.example/i);
  });

  it("sanitizes a bare DOCTYPE declaration", () => {
    expect(() =>
      sanitizeUntrustedSvg(`<!DOCTYPE svg>${svg("<rect/>", "")}`),
    ).not.toThrow();
  });

  it("sanitizes a bare PUBLIC DOCTYPE declaration", () => {
    expect(() =>
      sanitizeUntrustedSvg(
        `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${svg("<rect/>", "")}`,
      ),
    ).not.toThrow();
  });

  it("rejects DOCTYPE declarations with an internal subset", () => {
    expect(() =>
      sanitizeUntrustedSvg(
        `<!DOCTYPE svg [<!ENTITY xxe "pwned">]>${svg("<rect/>", "")}`,
      ),
    ).toThrow(/declarations/i);
  });

  it("rejects ENTITY declarations", () => {
    expect(() =>
      sanitizeUntrustedSvg(
        `<!ENTITY xxe SYSTEM "file:///etc/passwd">${svg("<rect/>", "")}`,
      ),
    ).toThrow(/declarations/i);
  });

  it("rejects non-SVG roots", () => {
    expect(() =>
      sanitizeUntrustedSvg(
        '<html xmlns="http://www.w3.org/1999/xhtml"><body>nope</body></html>',
      ),
    ).toThrow(/not a valid SVG/i);
    expect(() =>
      sanitizeUntrustedSvg('<div xmlns="http://www.w3.org/2000/svg">x</div>'),
    ).toThrow(/not a valid SVG/i);
  });

  it("rejects oversized dimensions", () => {
    expect(() =>
      sanitizeUntrustedSvg(svg("<rect/>", 'width="9000" height="100"')),
    ).toThrow(/dimensions|bounds/i);
    expect(() =>
      sanitizeUntrustedSvg(svg("<rect/>", 'viewBox="0 0 9000 100"')),
    ).toThrow(/viewBox|bounds/i);
  });

  it("rejects excessive node counts", () => {
    const nodes = Array.from(
      { length: 10_001 },
      (_, index) => `<g id="n${index}"/>`,
    ).join("");
    expect(() => sanitizeUntrustedSvg(svg(nodes, ""))).toThrow(
      /too many nodes/i,
    );
  });

  it("rejects nested svg roots", () => {
    expect(() =>
      sanitizeUntrustedSvg(
        svg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', ""),
      ),
    ).toThrow(/Nested SVG/i);
  });

  it("rejects filter bombs (too many filters or primitives)", () => {
    const filters = Array.from(
      { length: 17 },
      (_, index) =>
        `<filter id="f${index}"><feGaussianBlur stdDeviation="1"/></filter>`,
    ).join("");
    expect(() => sanitizeUntrustedSvg(svg(filters, ""))).toThrow(
      /too many filters/i,
    );

    const primitives = Array.from(
      { length: 130 },
      () => `<feOffset dx="1" dy="1"/>`,
    ).join("");
    expect(() =>
      sanitizeUntrustedSvg(svg(`<filter id="bomb">${primitives}</filter>`, "")),
    ).toThrow(/filters are too complex/i);
  });

  it("rejects path data that is too complex", () => {
    const pathData = `M0 0 ${"L1 1 ".repeat(200_000)}`;
    expect(() =>
      sanitizeUntrustedSvg(svg(`<path d="${pathData}"/>`, "")),
    ).toThrow(/paths are too complex/i);
  });

  it("rejects polygon point data that is too complex", () => {
    const points = Array.from({ length: 400_000 }, () => "1,1").join(" ");
    expect(() =>
      sanitizeUntrustedSvg(svg(`<polygon points="${points}"/>`, "")),
    ).toThrow(/polygon points are too complex/i);
  });

  it("retains a safe SVG document", () => {
    const source = svg(
      '<rect x="1" y="2" width="10" height="12" fill="#0f0"/><circle cx="5" cy="5" r="2"/>',
      'width="64" height="64" viewBox="0 0 64 64"',
    );
    const cleaned = sanitizeUntrustedSvg(source);
    expect(cleaned.toLowerCase()).toContain("<svg");
    expect(cleaned.toLowerCase()).toContain("<rect");
    expect(cleaned.toLowerCase()).toContain("<circle");
    expect(cleaned).toContain('width="64"');
  });
});

describe("sanitizeUntrustedSvg style attribute forbid + serialize/reparse", () => {
  function reparseImport(serialized: string): Element {
    // Mirrors SanitizedSvgMarkup: serialize → reparse as XML → import.
    const parsed = new DOMParser().parseFromString(serialized, "image/svg+xml");
    expect(parsed.querySelector("parsererror")).toBeNull();
    return document.importNode(parsed.documentElement, true);
  }

  it("forbids style attributes including CSS-escaped url() beacons", () => {
    // Review PoC: CSS escapes bypass a literal /url\s*\(/ strip on attribute values.
    const source = svg(
      "<rect/>",
      'style="background-image:u\\000072l(https://attacker.example/pixel)"',
    );
    const cleaned = sanitizeUntrustedSvg(source);
    expect(cleaned.toLowerCase()).not.toContain("style=");
    expect(cleaned).not.toMatch(/attacker\.example/i);
    expect(cleaned).not.toMatch(/u\\0*72l/i);
    const imported = reparseImport(cleaned);
    expect(imported.getAttribute("style")).toBeNull();
    expect(imported.outerHTML).not.toMatch(/attacker\.example/i);
  });

  it("forbids style attributes carrying image-set() network refs", () => {
    const source = svg(
      "<rect/>",
      'style="background-image:image-set(&quot;https://attacker.example/pixel&quot; 1x)"',
    );
    const cleaned = sanitizeUntrustedSvg(source);
    expect(cleaned.toLowerCase()).not.toContain("style=");
    expect(cleaned).not.toMatch(/image-set/i);
    expect(cleaned).not.toMatch(/attacker\.example/i);
    const imported = reparseImport(cleaned);
    expect(imported.getAttribute("style")).toBeNull();
  });

  it("forbids style-based oversized dimensions and filters that bypass attr bounds", () => {
    const source = svg(
      "<rect/>",
      'style="width:100000000px;height:100000000px;filter:blur(1000000px)"',
    );
    const cleaned = sanitizeUntrustedSvg(source);
    expect(cleaned.toLowerCase()).not.toContain("style=");
    expect(cleaned).not.toMatch(/100000000/);
    expect(cleaned).not.toMatch(/blur\(/i);
    const imported = reparseImport(cleaned);
    expect(imported.getAttribute("style")).toBeNull();
  });

  it("strips network-capable refs from feImage/use/data href and drops animate/set", () => {
    const source = `<svg ${SVG_NS} xmlns:xlink="http://www.w3.org/1999/xlink">
      <defs>
        <filter id="f">
          <feImage href="https://attacker.example/fe.png" xlink:href="https://attacker.example/fe-x.png"/>
        </filter>
      </defs>
      <use href="#icon" xlink:href="https://attacker.example/sprite.svg#icon"/>
      <image href="data:image/png;base64,AAAA" width="10" height="10"/>
      <animate attributeName="x" values="0;100" dur="1s"/>
      <set attributeName="visibility" to="hidden"/>
      <rect width="4" height="4" filter="url(#f)"/>
    </svg>`;
    const cleaned = sanitizeUntrustedSvg(source);
    // href-localName strip covers feImage/use/image/data hrefs; inert empty
    // elements may remain after DOMPurify (e.g. bare <feImage/>).
    expect(cleaned).not.toMatch(/attacker\.example/i);
    expect(cleaned).not.toMatch(/data:image\/png/i);
    expect(cleaned).not.toMatch(/\bhref\s*=/i);
    // Serialize/reparse must not resurrect network-capable refs.
    const imported = reparseImport(cleaned);
    expect(imported.outerHTML).not.toMatch(/attacker\.example/i);
    expect(imported.outerHTML).not.toMatch(/data:image\/png/i);
    expect(imported.outerHTML).not.toMatch(/\bhref\s*=/i);
    for (const element of [imported, ...imported.querySelectorAll("*")]) {
      for (const attribute of [...element.attributes]) {
        expect(attribute.localName.toLowerCase()).not.toBe("href");
        expect(attribute.value).not.toMatch(/attacker\.example/i);
      }
    }
    // Real pins: DOMPurify svg profile drops animate/set.
    expect(imported.querySelector("animate")).toBeNull();
    expect(imported.querySelector("set")).toBeNull();
    expect(cleaned.toLowerCase()).not.toContain("<animate");
    expect(cleaned.toLowerCase()).not.toMatch(/<set[\s>]/);
  });

  it("strips network-capable presentation attrs (mask/fill/stroke/filter/clip-path/marker-*)", () => {
    const presentationAttrs = [
      "fill",
      "stroke",
      "filter",
      "mask",
      "clip-path",
      "marker-start",
      "marker-mid",
      "marker-end",
    ] as const;
    // XML-safe fixtures: entity-encode quotes so DOMParser accepts the source.
    const imageSet = "image-set(&quot;https://attacker.example/p.png&quot; 1x)";
    // CSS escape \75 → 'u', so this is a disguised url() network beacon.
    const escapedUrl = "\\75 rl(https://attacker.example/p.png)";

    for (const attr of presentationAttrs) {
      for (const [label, value] of [
        ["image-set", imageSet],
        ["css-escaped-url", escapedUrl],
      ] as const) {
        const source = svg(
          `<rect ${attr}="${value}" width="10" height="10"/>`,
          "",
        );
        const cleaned = sanitizeUntrustedSvg(source);
        expect(cleaned, `${attr}/${label}`).not.toMatch(/attacker\.example/i);
        expect(cleaned, `${attr}/${label}`).not.toMatch(/image-set/i);
        const imported = reparseImport(cleaned);
        const rect = imported.querySelector("rect");
        expect(rect, `${attr}/${label}`).not.toBeNull();
        // Attr removed or neutralized: no attacker URL survives reparse.
        expect(rect?.getAttribute(attr) ?? "", `${attr}/${label}`).not.toMatch(
          /attacker\.example/i,
        );
        expect(imported.outerHTML, `${attr}/${label}`).not.toMatch(
          /attacker\.example/i,
        );
      }
    }
  });

  it("strips CSS filter shorthands (blur and chained drop-shadow) on presentation attrs", () => {
    const source = svg(
      '<rect filter="blur(9999px) drop-shadow(0 0 8px red)" width="10" height="10"/>',
      "",
    );
    const cleaned = sanitizeUntrustedSvg(source);
    expect(cleaned).not.toMatch(/blur\(/i);
    expect(cleaned).not.toMatch(/drop-shadow/i);
    expect(cleaned).not.toMatch(/9999/);
    const imported = reparseImport(cleaned);
    const rect = imported.querySelector("rect");
    expect(rect).not.toBeNull();
    const filter = rect?.getAttribute("filter") ?? "";
    expect(filter).not.toMatch(/blur\(/i);
    expect(filter).not.toMatch(/drop-shadow/i);
    expect(imported.outerHTML).not.toMatch(/blur\(/i);
  });

  it("preserves valid local url(#gradient) presentation refs through sanitize/reparse", () => {
    // De-vacuum: local fragment paint servers must survive the presentation
    // predicate that strips network-capable url()/image-set values.
    const source = svg(
      [
        "<defs>",
        '<linearGradient id="gradient">',
        '<stop offset="0" stop-color="#0f0"/>',
        '<stop offset="1" stop-color="#00f"/>',
        "</linearGradient>",
        "</defs>",
        '<rect fill="url(#gradient)" width="10" height="10"/>',
      ].join(""),
      'width="32" height="32"',
    );
    const cleaned = sanitizeUntrustedSvg(source);
    expect(cleaned).toMatch(/url\(#gradient\)/i);
    const imported = reparseImport(cleaned);
    expect(imported.querySelector("rect")?.getAttribute("fill")).toBe(
      "url(#gradient)",
    );
    expect(imported.querySelector("linearGradient")).not.toBeNull();
  });

  it("keeps presentation attributes on a safe SVG after serialize/reparse", () => {
    const source = svg(
      '<rect x="1" y="2" width="10" height="12" fill="#0f0"/>',
      'width="64" height="64" viewBox="0 0 64 64"',
    );
    const cleaned = sanitizeUntrustedSvg(source);
    const imported = reparseImport(cleaned);
    expect(imported.getAttribute("width")).toBe("64");
    expect(imported.getAttribute("viewBox")).toBe("0 0 64 64");
    expect(imported.querySelector("rect")).not.toBeNull();
  });
});
