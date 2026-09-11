import {
  extractLinksFromRoot,
  type CapturedLink,
  type ExtractLinksOptions,
  type NormalizedAnchor,
  type Platform,
  type Theme,
} from "@answerframe/shared";

export type CaptureRootRect = NonNullable<ExtractLinksOptions["rootRect"]>;

export interface CaptureAdapter {
  platform: Platform;
  label: string;
  findAnswerRoots(): Element[];
  findPreviousQuestion(root: Element): string;
  getAnswerText(root: Element): string;
  getTheme(): Theme;
  isAnswerComplete(root: Element): boolean;
  collectLinks(root: Element, rootRect: CaptureRootRect): Promise<CapturedLink[]>;
  captureHideSelectors: string[];
}

export const CHATGPT_CANDIDATE_SELECTOR = [
  "article[data-turn='assistant']",
  "section[data-turn='assistant']",
  "[data-turn='assistant']",
  "[data-testid^='conversation-turn']",
  "[data-message-author-role='assistant']",
  "[data-testid='conversation-turn']",
  "[data-message-id]",
  "article",
  "[class*='conversation-turn']",
].join(", ");

const CHATGPT_MESSAGE_SELECTOR = "[data-message-author-role='user'], [data-message-author-role='assistant']";

const GEMINI_EXPLICIT_ANSWER_SELECTOR = [
  "model-response",
  "message-content",
  "response-content",
  "[data-message-author-role='model']",
  "[data-message-author-role='assistant']",
  "[data-role='model']",
  "[data-role='assistant']",
].join(", ");

export const GEMINI_CANDIDATE_SELECTOR = [
  GEMINI_EXPLICIT_ANSWER_SELECTOR,
  "[data-testid*='response']",
  "[class*='model-response']",
  "[class*='response-text']",
  "[class*='response-container']",
  "article",
].join(", ");

const GEMINI_MESSAGE_SELECTOR = [
  "[data-message-author-role]",
  "[data-role='user']",
  "[data-role='model']",
  "message-content",
  "user-query",
  "[data-testid='user-query']",
].join(", ");

const GEMINI_USER_SELECTOR = [
  "[data-message-author-role='user']",
  "[data-message-author-role='human']",
  "[data-role='user']",
  "user-query",
  "[data-testid='user-query']",
].join(", ");

const SOURCE_WORDS = /sources?|citations?|references?|来源|引用|出处/iu;
const SHARE_WORDS = /share|export|分享|导出/iu;

function cleanText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function roleOf(element: Element): string {
  return (
    element.getAttribute("data-message-author-role") ||
    element.getAttribute("data-role") ||
    ""
  ).toLowerCase();
}

function hasRole(element: Element, selector: string): boolean {
  return element.matches(selector) || Boolean(element.querySelector(selector));
}

function visible(element: Element): boolean {
  const htmlElement = element as HTMLElement;
  if (htmlElement.hidden || htmlElement.getAttribute("aria-hidden") === "true") return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(htmlElement);
  if (style?.display === "none" || style?.visibility === "hidden") return false;
  const rect = htmlElement.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function textFromContent(root: Element, selectors: string): string {
  const content = root.matches(selectors) ? root : root.querySelector(selectors);
  return cleanText(content?.textContent || root.textContent || "");
}

function themeFromDocument(doc: Document): Theme {
  if (doc.documentElement.classList.contains("dark")) return "dark";
  const style = doc.defaultView?.getComputedStyle(doc.body || doc.documentElement);
  const background = style?.backgroundColor || "";
  const channels = background.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (channels) {
    const brightness = (Number(channels[1]) + Number(channels[2]) + Number(channels[3])) / 3;
    if (brightness < 125) return "dark";
  }
  return "light";
}

function hasStreamingMarker(root: Element): boolean {
  return Boolean(
    root.matches("[aria-busy='true'], [data-is-streaming='true'], [data-streaming='true']") ||
    root.querySelector("[aria-busy='true'], [data-is-streaming='true'], [data-streaming='true'], [class*='streaming'], [class*='generating']"),
  );
}

function hasVisibleStopButton(doc: Document): boolean {
  return Array.from(doc.querySelectorAll("button, [role='button']")).some((button) => {
    if (!visible(button)) return false;
    const label = [button.getAttribute("aria-label"), button.getAttribute("title"), button.textContent]
      .filter(Boolean)
      .join(" ");
    return /stop|cancel generation|停止|取消生成|正在生成/iu.test(label);
  });
}

function findPreviousQuestionFromDocument(root: Element, selector: string): string {
  const messages = Array.from(root.ownerDocument.querySelectorAll(selector));
  const index = messages.findIndex((item) => item === root || item.contains(root) || root.contains(item));
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = messages[cursor];
    if (!hasRole(candidate, GEMINI_USER_SELECTOR) && roleOf(candidate) !== "user" && roleOf(candidate) !== "human") continue;
    const text = cleanText(candidate.textContent || "");
    if (text) return text;
  }
  return "";
}

function markSurface(links: CapturedLink[], surface: "answer" | "sources-panel"): CapturedLink[] {
  return links.map((link) => ({
    ...link,
    sourceSurface: link.status === "unresolved" ? "unresolved" : surface,
  }));
}

function mergeLinks(...groups: CapturedLink[][]): CapturedLink[] {
  const seen = new Set<string>();
  const merged: CapturedLink[] = [];
  for (const group of groups) {
    for (const link of group) {
      const key = link.url || `unresolved:${link.label}:${link.sourceSurface || "unknown"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...link, id: `link-${merged.length + 1}`, order: merged.length });
    }
  }
  return merged;
}

function anchorForElement(element: Element | undefined, rootRect: CaptureRootRect): NormalizedAnchor {
  if (!element || rootRect.width <= 0 || rootRect.height <= 0) {
    return { x: 0.02, y: 0.94, width: 0.04, height: 0.03 };
  }
  const rect = (element as HTMLElement).getBoundingClientRect();
  const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return {
    x: clamp((rect.left - rootRect.left) / rootRect.width),
    y: clamp((rect.top - rootRect.top) / rootRect.height),
    width: clamp(rect.width / rootRect.width),
    height: clamp(rect.height / rootRect.height),
  };
}

function sourceLabel(element: Element): string {
  return [element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function findGeminiSourcesButton(root: Element): HTMLElement | undefined {
  const rootRect = (root as HTMLElement).getBoundingClientRect();
  return Array.from(root.ownerDocument.querySelectorAll("button, [role='button']"))
    .filter((candidate): candidate is HTMLElement => visible(candidate))
    .filter((candidate) => {
      const label = sourceLabel(candidate);
      return SOURCE_WORDS.test(label) && !SHARE_WORDS.test(label);
    })
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      const distance = (element: HTMLElement, rect: DOMRect) => {
        if (root.contains(element)) return 0;
        const vertical = rect.bottom < rootRect.top ? rootRect.top - rect.bottom : rect.top > rootRect.bottom ? rect.top - rootRect.bottom : 0;
        return vertical + Math.abs(rect.left - rootRect.left) * 0.1;
      };
      return distance(left, leftRect) - distance(right, rightRect);
    })[0];
}

function findGeminiSourcesPanel(root: Element): Element | undefined {
  const candidates = Array.from(root.ownerDocument.querySelectorAll(
    "aside, section, [role='complementary'], [role='dialog'], [data-citation], [data-citation-id], [data-source], [data-source-id], [data-reference], [data-reference-id], [class*='citation'], [class*='source-panel'], [class*='sources-panel']",
  ));
  return candidates
    .filter((candidate) => candidate !== root && !root.contains(candidate) && !candidate.contains(root) && visible(candidate))
    .map((candidate) => {
      const label = sourceLabel(candidate);
      const links = candidate.querySelectorAll("a[href], area[href], [data-url], [data-href]").length;
      const sourceMarker = candidate.matches("[data-citation], [data-source], [data-reference]") || SOURCE_WORDS.test(label);
      return { candidate, links, sourceMarker };
    })
    .filter((item) => item.links > 0 && item.sourceMarker)
    .sort((left, right) => right.links - left.links)[0]?.candidate;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function openAndReadGeminiSources(root: Element, rootRect: CaptureRootRect): Promise<CapturedLink[]> {
  const document = root.ownerDocument;
  const before = findGeminiSourcesPanel(root);
  const button = findGeminiSourcesButton(root);
  let opened = false;
  if (!before && button) {
    button.click();
    opened = true;
    for (let attempt = 0; attempt < 8 && !findGeminiSourcesPanel(root); attempt += 1) await wait(120);
  }

  try {
    const panel = findGeminiSourcesPanel(root);
    if (!panel) return [];
    const fallbackAnchor = anchorForElement(button, rootRect);
    const links = extractLinksFromRoot(panel, {
      rootRect,
      unresolvedSelectors: ["[data-citation]", "[data-citation-id]", "[data-source]", "[data-source-id]", "[data-reference]", "[data-reference-id]"],
    });
    return markSurface(links, "sources-panel").map((link) => ({ ...link, anchor: fallbackAnchor }));
  } finally {
    if (opened && button) {
      button.click();
      await wait(80);
      if (findGeminiSourcesPanel(root)) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }
    }
  }
}

export function findChatgptAnswerRoots(doc: Document): Element[] {
  const roots: Element[] = [];
  for (const candidate of Array.from(doc.querySelectorAll(CHATGPT_CANDIDATE_SELECTOR))) {
    if (cleanText(candidate.textContent || "").length < 20) continue;
    const turnRole = candidate.getAttribute("data-turn")?.toLowerCase();
    if (turnRole && turnRole !== "assistant") continue;
    const roleNode = candidate.matches("[data-message-author-role]")
      ? candidate
      : candidate.querySelector("[data-message-author-role]");
    if (turnRole !== "assistant" && roleNode?.getAttribute("data-message-author-role") !== "assistant") continue;
    const markdown = candidate.querySelector(".markdown, [class*='markdown']");
    const root = markdown?.closest("[data-turn='assistant'], [data-testid^='conversation-turn'], [data-message-author-role='assistant'], article, section") || candidate;
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

export function findGeminiAnswerRoots(doc: Document): Element[] {
  const roots: Element[] = [];
  for (const candidate of Array.from(doc.querySelectorAll(GEMINI_CANDIDATE_SELECTOR))) {
    if (!visible(candidate) || cleanText(candidate.textContent || "").length < 20) continue;
    const role = roleOf(candidate);
    if (role && !["model", "assistant"].includes(role)) continue;
    if (candidate.closest(GEMINI_USER_SELECTOR)) continue;
    if (!role && !hasRole(candidate, "message-content, [data-message-author-role='model'], [data-message-author-role='assistant'], [data-role='model'], [data-role='assistant']")) continue;
    const explicit = candidate.matches(GEMINI_EXPLICIT_ANSWER_SELECTOR)
      ? candidate
      : candidate.querySelector(GEMINI_EXPLICIT_ANSWER_SELECTOR);
    const root = explicit || candidate;
    if (!visible(root) || cleanText(root.textContent || "").length < 20) continue;
    const nestedIndex = roots.findIndex((existing) => existing.contains(root) || root.contains(existing));
    if (nestedIndex >= 0) {
      if (roots[nestedIndex].contains(root)) continue;
      roots.splice(nestedIndex, 1);
    }
    roots.push(root);
  }
  return roots;
}

const chatgptAdapter: CaptureAdapter = {
  platform: "chatgpt",
  label: "ChatGPT",
  findAnswerRoots: () => findChatgptAnswerRoots(document),
  findPreviousQuestion: (root) => findPreviousQuestionFromDocument(root, CHATGPT_MESSAGE_SELECTOR),
  getAnswerText: (root) => textFromContent(root, ".markdown, [class*='markdown']"),
  getTheme: () => themeFromDocument(document),
  isAnswerComplete: (root) => !hasStreamingMarker(root),
  collectLinks: async (root, rootRect) => markSurface(extractLinksFromRoot(root, { rootRect }), "answer"),
  captureHideSelectors: [
    "button[aria-label*='Copy']",
    "button[aria-label*='复制']",
    "[data-testid*='copy']",
    "[data-testid*='feedback']",
    "button[aria-label*='Regenerate']",
    "button[aria-label*='重新生成']",
  ],
};

const geminiAdapter: CaptureAdapter = {
  platform: "gemini",
  label: "Gemini",
  findAnswerRoots: () => findGeminiAnswerRoots(document),
  findPreviousQuestion: (root) => findPreviousQuestionFromDocument(root, GEMINI_MESSAGE_SELECTOR),
  getAnswerText: (root) => textFromContent(root, "model-response, message-content, response-content, [class*='markdown'], [class*='response']"),
  getTheme: () => themeFromDocument(document),
  isAnswerComplete: (root) => !hasStreamingMarker(root) && !hasVisibleStopButton(document),
  collectLinks: async (root, rootRect) => {
    const answerLinks = markSurface(extractLinksFromRoot(root, {
      rootRect,
      unresolvedSelectors: ["[data-citation]", "[data-citation-id]", "[data-source]", "[data-source-id]", "[data-reference]", "[data-reference-id]"],
    }), "answer");
    const panelLinks = await openAndReadGeminiSources(root, rootRect);
    return mergeLinks(answerLinks, panelLinks);
  },
  captureHideSelectors: [
    "button[aria-label*='Copy']",
    "button[aria-label*='复制']",
    "button[aria-label*='Share']",
    "button[aria-label*='分享']",
    "button[aria-label*='Export']",
    "button[aria-label*='导出']",
    "[data-testid*='feedback']",
    "[data-testid*='thumb']",
    "[class*='response-actions']",
  ],
};

export function getCaptureAdapter(location: Location): CaptureAdapter | undefined {
  const hostname = location.hostname.toLowerCase();
  if (hostname === "gemini.google.com" || hostname.endsWith(".gemini.google.com")) return geminiAdapter;
  if (hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com") || hostname === "chat.openai.com") return chatgptAdapter;
  return undefined;
}
