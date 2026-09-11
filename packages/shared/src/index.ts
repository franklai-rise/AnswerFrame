export type Platform = "chatgpt" | "gemini";
export type Theme = "light" | "dark";

/** Where a captured source was discovered in the provider UI. */
export type LinkSurface = "answer" | "sources-panel" | "text" | "unresolved";

export type LinkStatus =
  | "checking"
  | "available"
  | "redirected"
  | "restricted"
  | "unavailable"
  | "unknown"
  | "unresolved";

export type LinkKind = "youtube" | "doi" | "pdf" | "journal" | "general";

export interface NormalizedAnchor {
  /** Coordinates are normalized to the captured page (0..1), not the browser viewport. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotPart {
  pageIndex: number;
  dataUrl: string;
  width: number;
  height: number;
}

export interface StoredImagePart {
  pageIndex: number;
  path: string;
  width: number;
  height: number;
  bytes?: number;
}

export interface CapturedLink {
  id: string;
  label: string;
  originalUrl: string;
  url: string;
  kind: LinkKind;
  order: number;
  pageIndex: number;
  anchor: NormalizedAnchor;
  status: LinkStatus;
  sourceSurface?: LinkSurface;
  statusCode?: number;
  finalUrl?: string;
  checkedAt?: string;
}

export interface CaptureDraft {
  platform: Platform;
  conversationUrl: string;
  question: string;
  answerText: string;
  theme: Theme;
  screenshotParts: ScreenshotPart[];
  links: CapturedLink[];
}

export interface TimestampLike {
  seconds: number;
  nanoseconds: number;
}

export type ClipTimestamp = TimestampLike | string;

export interface ClipRecord extends Omit<CaptureDraft, "screenshotParts"> {
  id: string;
  ownerUid: string;
  title: string;
  note: string;
  tags: string[];
  imageParts: StoredImagePart[];
  thumbnailPath: string;
  createdAt: ClipTimestamp;
  updatedAt: ClipTimestamp;
  deletedAt: ClipTimestamp | null;
  schemaVersion: 1;
}

export interface ClipPatch {
  title?: string;
  question?: string;
  note?: string;
  tags?: string[];
  links?: CapturedLink[];
}

export interface ExtractLinksOptions {
  pageIndex?: number;
  rootRect?: { left: number; top: number; width: number; height: number };
  unresolvedSelectors?: string[];
}

export interface RailItem extends CapturedLink {
  railTop: number;
  collisionOffset: number;
}

const DOI_PATTERN = /\b10\.\d{4,9}\/[\w.\-;()/:]+/gi;
const URL_PATTERN = /https?:\/\/[^\s<>()\[\]"']+/gi;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function cleanUrlCandidate(value: string): string {
  return value.trim().replace(/[),.;:]+$/g, "");
}

/**
 * Normalizes only URL components that are safe to normalize. Unknown query
 * parameters are deliberately preserved because they may identify a paper,
 * video, or version of a source.
 */
export function normalizeUrl(value: string): string | null {
  const candidate = cleanUrlCandidate(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === "http:" && parsed.port === "80") ||
        (parsed.protocol === "https:" && parsed.port === "443")) {
      parsed.port = "";
    }
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString();
  } catch {
    return null;
  }
}

export function classifyLink(value: string): LinkKind {
  const normalized = normalizeUrl(value);
  if (!normalized) return "general";
  const parsed = new URL(normalized);
  const host = parsed.hostname;
  const path = parsed.pathname.toLowerCase();
  if (host === "youtu.be" || host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
    return "youtube";
  }
  if (host === "doi.org" || /^10\.\d{4,9}\//i.test(path.replace(/^\//, "")) || /doi\//i.test(path)) {
    return "doi";
  }
  if (path.endsWith(".pdf") || /(?:^|[?&])(format|type)=pdf/i.test(parsed.search)) return "pdf";
  if (["nature.com", "sciencedirect.com", "springer.com", "wiley.com", "acm.org", "ieeexplore.ieee.org"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return "journal";
  }
  return "general";
}

function anchorForElement(element: Element, options: ExtractLinksOptions): NormalizedAnchor {
  const root = options.rootRect;
  const rect = typeof (element as HTMLElement).getBoundingClientRect === "function"
    ? (element as HTMLElement).getBoundingClientRect()
    : { left: 0, top: 0, width: 0, height: 0 };
  if (!root || root.width <= 0 || root.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return {
    x: clamp01((rect.left - root.left) / root.width),
    y: clamp01((rect.top - root.top) / root.height),
    width: clamp01(rect.width / root.width),
    height: clamp01(rect.height / root.height),
  };
}

function textFor(element: Element, fallback: string): string {
  const text = (element.textContent || "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function createLink(
  value: string,
  label: string,
  anchor: NormalizedAnchor,
  order: number,
  pageIndex: number,
): CapturedLink | null {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;
  return {
    id: `link-${order + 1}`,
    label: label || normalized,
    originalUrl: cleanUrlCandidate(value),
    url: normalized,
    kind: classifyLink(normalized),
    order,
    pageIndex,
    anchor,
    status: "checking",
  };
}

/** Extracts visible anchors, embeds, citation URLs, DOIs, and unresolved source controls. */
export function extractLinksFromRoot(root: Element, options: ExtractLinksOptions = {}): CapturedLink[] {
  const pageIndex = options.pageIndex ?? 0;
  const found: CapturedLink[] = [];
  const seen = new Set<string>();
  const add = (candidate: CapturedLink | null) => {
    if (!candidate || seen.has(candidate.url)) return;
    seen.add(candidate.url);
    candidate.order = found.length;
    candidate.id = `link-${found.length + 1}`;
    found.push(candidate);
  };

  root.querySelectorAll("a[href], area[href]").forEach((element) => {
    const href = element.getAttribute("href") || "";
    add(createLink(href, textFor(element, href), anchorForElement(element, options), found.length, pageIndex));
  });

  root.querySelectorAll("iframe[src], video[src], [data-url], [data-href], [data-source-url], [data-citation-url], [data-reference-url]").forEach((element) => {
    const value = element.getAttribute("src") || element.getAttribute("data-url") || element.getAttribute("data-href") || element.getAttribute("data-source-url") || element.getAttribute("data-citation-url") || element.getAttribute("data-reference-url") || "";
    add(createLink(value, textFor(element, value), anchorForElement(element, options), found.length, pageIndex));
  });

  const text = root.textContent || "";
  for (const candidate of text.match(URL_PATTERN) || []) {
    add(createLink(candidate, candidate, { x: 0, y: 0, width: 0, height: 0 }, found.length, pageIndex));
  }
  for (const doi of text.match(DOI_PATTERN) || []) {
    add(createLink(`https://doi.org/${doi}`, doi, { x: 0, y: 0, width: 0, height: 0 }, found.length, pageIndex));
  }

  const unresolvedSelectors = options.unresolvedSelectors ?? ["[data-citation]", "[data-citation-id]", "[data-source]", "[data-source-id]", "[data-reference]", "[data-reference-id]"];
  for (const selector of unresolvedSelectors) {
    root.querySelectorAll(selector).forEach((element) => {
      const value = element.getAttribute("data-url") || element.getAttribute("data-href") || element.getAttribute("data-source-url") || element.getAttribute("data-citation-url") || element.getAttribute("data-reference-url") || element.getAttribute("href") || "";
      if (normalizeUrl(value)) return;
      found.push({
        id: `link-${found.length + 1}`,
        label: textFor(element, "Unresolved citation"),
        originalUrl: value,
        url: "",
        kind: "general",
        order: found.length,
        pageIndex,
        anchor: anchorForElement(element, options),
        status: "unresolved",
      });
    });
  }
  return found;
}

/**
 * Places source cards close to their original vertical position while keeping
 * a readable minimum gap. The returned `railTop` is in CSS pixels.
 */
export function layoutSourceRail(
  links: CapturedLink[],
  screenshotHeight: number,
  cardHeight = 74,
  gap = 12,
): RailItem[] {
  const safeHeight = Math.max(1, screenshotHeight);
  const cursorByPage = new Map<number, number>();
  return [...links]
    .sort((a, b) => a.pageIndex - b.pageIndex || a.anchor.y - b.anchor.y || a.order - b.order)
    .map((link) => {
      const desired = clamp01(link.anchor.y) * safeHeight;
      const cursor = cursorByPage.get(link.pageIndex) ?? 0;
      const top = Math.max(desired, cursor);
      cursorByPage.set(link.pageIndex, top + cardHeight + gap);
      return { ...link, railTop: top, collisionOffset: Math.max(0, top - desired) };
    });
}

export function linkStatusLabel(status: LinkStatus): string {
  return {
    checking: "Checking",
    available: "Available",
    redirected: "Redirected",
    restricted: "Restricted",
    unavailable: "Unavailable",
    unknown: "Unknown",
    unresolved: "Needs URL",
  }[status];
}

export function isPublicHttpUrl(value: string): boolean {
  const normalized = normalizeUrl(value);
  if (!normalized) return false;
  const hostname = new URL(normalized).hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "ip6-localhost") return false;
  if (hostname === "metadata.google.internal" || hostname === "metadata.google") return false;
  if (hostname.includes(":")) return !isPrivateIpv6(hostname);
  const octets = hostname.split(".").map(Number);
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = octets;
    if (a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  return true;
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd");
}

export function mapHttpStatus(statusCode: number | null, finalUrlChanged = false): LinkStatus {
  if (statusCode === null) return "unknown";
  if (statusCode === 401 || statusCode === 403 || statusCode === 429) return "restricted";
  if (statusCode === 404 || statusCode === 410) return "unavailable";
  if (statusCode >= 200 && statusCode < 300) return finalUrlChanged ? "redirected" : "available";
  if (statusCode >= 300 && statusCode < 400) return "redirected";
  return "unknown";
}
