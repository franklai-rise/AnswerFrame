import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  findChatgptAnswerRoots,
  findGeminiAnswerRoots,
  getCaptureAdapter,
} from "./adapters";

function makeVisible(dom: JSDOM): void {
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return {
      x: 20,
      y: 40,
      top: 40,
      left: 20,
      right: 620,
      bottom: 240,
      width: 600,
      height: 200,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

describe("provider capture adapters", () => {
  it("finds a Gemini model message without treating the preceding user query as an answer", () => {
    const dom = new JSDOM(`<main>
      <div data-role="user">Explain PINNs in one paragraph.</div>
      <article class="turn"><model-response><message-content data-role="model">
        <p>Physics-informed neural networks combine data and governing equations.</p>
        <a href="https://doi.org/10.1038/s42254-021-00314-5">Review paper</a>
      </message-content></model-response></article>
    </main>`);
    makeVisible(dom);
    const roots = findGeminiAnswerRoots(dom.window.document);
    expect(roots).toHaveLength(1);
    expect(roots[0].textContent).toContain("governing equations");
    expect(roots[0].textContent).not.toContain("Explain PINNs");
  });

  it("keeps the ChatGPT selector regression covered", () => {
    const dom = new JSDOM(`<main>
      <div data-message-author-role="user">What is a PINN?</div>
      <article data-testid="conversation-turn"><div data-message-author-role="assistant"><div class="markdown">A PINN adds a physics residual.</div></div></article>
    </main>`);
    const roots = findChatgptAnswerRoots(dom.window.document);
    expect(roots).toHaveLength(1);
    expect(roots[0].textContent).toContain("physics residual");
  });

  it("finds the current ChatGPT article turn when role is declared on the outer node", () => {
    const dom = new JSDOM(`<main>
      <article data-turn="user"><div data-message-author-role="user">What is a PINN?</div></article>
      <article data-turn="assistant" data-testid="conversation-turn-2"><div class="markdown prose">A PINN adds a physics residual and boundary conditions.</div></article>
    </main>`);
    const roots = findChatgptAnswerRoots(dom.window.document);
    expect(roots).toHaveLength(1);
    expect(roots[0].getAttribute("data-turn")).toBe("assistant");
  });

  it("keeps provider routing working for a ChatGPT subdomain", () => {
    expect(getCaptureAdapter({ hostname: "www.chatgpt.com" } as Location)?.platform).toBe("chatgpt");
  });

  it("temporarily reads Gemini Sources and restores the panel", async () => {
    const dom = new JSDOM(`<main>
      <div data-role="user">List the key papers.</div>
      <article><message-content data-role="model"><p>Here are the key papers.</p></message-content><button aria-label="Sources">Sources</button></article>
    </main>`);
    makeVisible(dom);
    const sourceButton = dom.window.document.querySelector("button")!;
    sourceButton.addEventListener("click", () => {
      const existing = dom.window.document.querySelector("aside");
      if (existing) existing.remove();
      else {
        const panel = dom.window.document.createElement("aside");
        panel.innerHTML = `<h2>Sources</h2><a href="https://www.youtube.com/watch?v=demo">Video source</a>`;
        dom.window.document.body.append(panel);
      }
    });
    const previousDocument = (globalThis as { document?: Document }).document;
    const previousWindow = (globalThis as { window?: Window }).window;
    Object.assign(globalThis, { document: dom.window.document, window: dom.window });
    try {
      const adapter = getCaptureAdapter({ hostname: "gemini.google.com" } as Location);
      expect(adapter?.platform).toBe("gemini");
      const root = adapter!.findAnswerRoots()[0];
      const links = await adapter!.collectLinks(root, { left: 0, top: 0, width: 600, height: 400 });
      expect(links.some((link) => link.sourceSurface === "sources-panel" && link.kind === "youtube")).toBe(true);
      expect(dom.window.document.querySelector("aside")).toBeNull();
    } finally {
      if (previousDocument) Object.assign(globalThis, { document: previousDocument });
      else delete (globalThis as { document?: Document }).document;
      if (previousWindow) Object.assign(globalThis, { window: previousWindow });
      else delete (globalThis as { window?: Window }).window;
    }
  });
});
