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

  it("rejects DOCTYPE declarations", () => {
    expect(() =>
      sanitizeUntrustedSvg(
        `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${svg("<rect/>", "")}`,
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
