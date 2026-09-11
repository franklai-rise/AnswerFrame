import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  classifyLink,
  extractLinksFromRoot,
  isPublicHttpUrl,
  layoutSourceRail,
  mapHttpStatus,
  normalizeUrl,
} from "./index";

describe("AnswerFrame shared link utilities", () => {
  it("normalizes safely without dropping unknown query parameters", () => {
    expect(normalizeUrl("HTTPS://Example.COM:443/paper/?token=a#section")).toBe("https://example.com/paper?token=a");
  });

  it("extracts and deduplicates anchors, embeds, URL text, and unresolved citations", () => {
    const dom = new JSDOM(`<article>
      <a href="https://youtu.be/demo">Watch video</a>
      <a href="https://youtu.be/demo#time">Duplicate video</a>
      <iframe src="https://www.youtube.com/embed/demo"></iframe>
      <p>See https://doi.org/10.1038/s41586-021-03819-2</p>
      <span data-citation>Nature reference without URL</span>
    </article>`);
    const links = extractLinksFromRoot(dom.window.document.querySelector("article")!);
    expect(links.map((item) => item.kind)).toEqual(["youtube", "youtube", "doi", "general"]);
    expect(links.find((item) => item.status === "unresolved")?.label).toContain("Nature");
  });

  it("keeps source cards from colliding", () => {
    const links = [0, 1, 2].map((index) => ({
      id: String(index), label: String(index), originalUrl: `https://example.com/${index}`,
      url: `https://example.com/${index}`, kind: "general" as const, order: index, pageIndex: 0,
      anchor: { x: 0, y: 0.1 + index * 0.01, width: 0.2, height: 0.02 }, status: "checking" as const,
    }));
    const rail = layoutSourceRail(links, 500, 80, 10);
    expect(rail[1].railTop).toBeGreaterThanOrEqual(rail[0].railTop + 90);
    expect(rail[2].collisionOffset).toBeGreaterThan(0);
  });

  it("classifies papers and rejects private validator targets", () => {
    expect(classifyLink("https://doi.org/10.1016/j.cma.2020.113766")).toBe("doi");
    expect(classifyLink("https://example.org/files/paper.pdf")).toBe("pdf");
    expect(isPublicHttpUrl("http://192.168.1.4/a")).toBe(false);
    expect(isPublicHttpUrl("http://127.0.0.1:8080")).toBe(false);
    expect(isPublicHttpUrl("https://example.org")).toBe(true);
  });

  it("maps validator status codes to the stable status contract", () => {
    expect(mapHttpStatus(200)).toBe("available");
    expect(mapHttpStatus(200, true)).toBe("redirected");
    expect(mapHttpStatus(403)).toBe("restricted");
    expect(mapHttpStatus(404)).toBe("unavailable");
    expect(mapHttpStatus(null)).toBe("unknown");
  });
});
