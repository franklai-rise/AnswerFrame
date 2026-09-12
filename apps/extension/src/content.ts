import {
  type CaptureDraft,
  type ScreenshotPart,
} from "@answerframe/shared";
import { getCaptureAdapter, type CaptureAdapter } from "./adapters";
import { createDraftTransfer, DRAFT_TRANSFER_KEY, isDraftTransfer } from "./draft-transfer";

const BUTTON_CLASS = "answerframe-save-button";
const ROOT_MARK = "data-answerframe-root";
const adapter: CaptureAdapter | undefined = getCaptureAdapter(window.location);
let observer: MutationObserver | undefined;
const storedDraftForwards = new Map<string, Promise<{ ok: boolean; error?: string }>>();
const acknowledgedTransferIds = new Set<string>();

function answerRoots(): Element[] {
  return adapter?.findAnswerRoots() || [];
}

function injectButtons(): void {
  if (!adapter) return;
  ensurePageStyles();
  for (const root of answerRoots()) {
    if (root.querySelector(`.${BUTTON_CLASS}`)) continue;
    root.setAttribute(ROOT_MARK, "true");
    const actionBar = document.createElement("div");
    actionBar.className = "answerframe-actions";
    const button = document.createElement("button");
    button.className = BUTTON_CLASS;
    button.type = "button";
    const buttonIcon = document.createElement("span");
    buttonIcon.className = "answerframe-icon";
    buttonIcon.textContent = "⌁";
    const buttonLabel = document.createElement("span");
    buttonLabel.className = "answerframe-label";
    buttonLabel.textContent = "Save to AnswerFrame";
    button.append(buttonIcon, buttonLabel);
    button.addEventListener("click", () => void captureAnswer(root, button));
    actionBar.append(button);
    root.append(actionBar);
  }
}

async function captureAnswer(root: Element, button: HTMLButtonElement): Promise<void> {
  if (!adapter) return;
  if (!adapter.isAnswerComplete(root)) {
    showToast(`${adapter.label} 正在生成回答，请完成后再保存`, true);
    return;
  }
  button.disabled = true;
  button.dataset.state = "capturing";
  setSaveButtonLabel(button, "正在截取回答…");
  const scrollTarget = findScrollTarget(root);
  const originalScroll = readScrollTop(scrollTarget);
  const activeElement = document.activeElement as HTMLElement | null;
  const rootRect = (root as HTMLElement).getBoundingClientRect();
  const totalHeight = Math.max((root as HTMLElement).scrollHeight || rootRect.height, rootRect.height);
  const rootTop = rootRect.top + originalScroll;
  const dpr = window.devicePixelRatio || 1;
  const captureRect = { left: rootRect.left, top: rootRect.top, width: rootRect.width, height: totalHeight };
  const theme = adapter.getTheme();
  const answerText = adapter.getAnswerText(root);
  const question = adapter.findPreviousQuestion(root);
  try {
    // Read links while the answer is at the user's original scroll position so
    // normalized anchors map to the stitched screenshot rather than the final
    // segment captured below. Gemini may briefly open and close its Sources
    // panel here; it is not included in the screenshot.
    const links = await adapter.collectLinks(root, captureRect);
    document.documentElement.classList.add("answerframe-capture-mode");
    const viewportHeight = Math.max(260, window.innerHeight - 104);
    const segmentHeight = Math.min(viewportHeight, 1200);
    const crops: string[] = [];
    for (let offset = 0; offset < totalHeight; offset += segmentHeight) {
      writeScrollTop(scrollTarget, Math.max(0, rootTop + offset));
      await delay(220);
      const currentRect = (root as HTMLElement).getBoundingClientRect();
      const top = Math.max(0, currentRect.top);
      const bottom = Math.min(window.innerHeight, currentRect.bottom);
      if (bottom <= top) continue;
      const capture = await chrome.runtime.sendMessage({ type: "capture-visible" }) as { dataUrl?: string; error?: string };
      if (capture?.error || !capture?.dataUrl) throw new Error(capture?.error || "截图失败");
      crops.push(await cropDataUrl(capture.dataUrl, { left: currentRect.left, top, width: currentRect.width, height: bottom - top }, dpr));
    }
    const screenshotParts = await stitchCrops(crops, 1600, 15000);
    const draft: CaptureDraft = { platform: adapter.platform, conversationUrl: window.location.href, question, answerText, theme, screenshotParts, links };
    setSaveButtonLabel(button, "正在打开预览…");
    showPreview(draft);
  } catch (error) {
    showToast(error instanceof Error ? error.message : `捕获失败；请保持 ${adapter.label} 标签页可见后重试`, true);
  } finally {
    document.documentElement.classList.remove("answerframe-capture-mode");
    writeScrollTop(scrollTarget, originalScroll);
    activeElement?.focus({ preventScroll: true });
    button.disabled = false;
    delete button.dataset.state;
    setSaveButtonLabel(button, "Save to AnswerFrame");
  }
}

function setSaveButtonLabel(button: HTMLButtonElement, label: string): void {
  const labelElement = button.querySelector<HTMLElement>(".answerframe-label");
  if (labelElement) labelElement.textContent = label;
}

function findScrollTarget(root: Element): Element | Window {
  let current: Element | null = root.parentElement;
  while (current && current !== document.body) {
    const style = getComputedStyle(current);
    if ((style.overflowY === "auto" || style.overflowY === "scroll" || style.overflow === "auto" || style.overflow === "scroll") && (current as HTMLElement).scrollHeight > (current as HTMLElement).clientHeight + 8) return current;
    current = current.parentElement;
  }
  return window;
}

function readScrollTop(target: Element | Window): number {
  return target === window ? window.scrollY : (target as Element).scrollTop;
}

function writeScrollTop(target: Element | Window, value: number): void {
  if (target === window) window.scrollTo({ top: value, behavior: "instant" as ScrollBehavior });
  else (target as Element).scrollTop = value;
}

async function cropDataUrl(dataUrl: string, rect: { left: number; top: number; width: number; height: number }, dpr: number): Promise<string> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器不支持截图裁切");
  context.drawImage(image, Math.round(rect.left * dpr), Math.round(rect.top * dpr), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", .9);
}

async function stitchCrops(crops: string[], maxWidth: number, maxPageHeight: number): Promise<ScreenshotPart[]> {
  if (!crops.length) throw new Error("没有捕获到回答区域");
  const images = await Promise.all(crops.map(loadImage));
  const scale = Math.min(1, maxWidth / Math.max(...images.map((image) => image.naturalWidth || image.width)));
  const widths = images.map((image) => Math.round((image.naturalWidth || image.width) * scale));
  const heights = images.map((image) => Math.round((image.naturalHeight || image.height) * scale));
  const parts: ScreenshotPart[] = [];
  let index = 0;
  for (let start = 0; start < images.length;) {
    let height = 0; let end = start;
    while (end < images.length && height + heights[end] <= maxPageHeight) { height += heights[end]; end += 1; }
    if (end === start) { end += 1; height = Math.min(heights[start], maxPageHeight); }
    const canvas = document.createElement("canvas"); canvas.width = Math.max(...widths); canvas.height = height;
    const context = canvas.getContext("2d"); if (!context) throw new Error("浏览器不支持截图拼接");
    let y = 0; for (let i = start; i < end; i += 1) { context.drawImage(images[i], 0, y, widths[i], heights[i]); y += heights[i]; }
    parts.push({ pageIndex: index, dataUrl: canvas.toDataURL("image/webp", .9), width: canvas.width, height: canvas.height });
    index += 1; start = end;
  }
  return parts;
}

function loadImage(src: string): Promise<HTMLImageElement> { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("无法读取截图")); image.src = src; }); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, ms)); }

function makeElement<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function makeField<K extends "input" | "textarea">(labelText: string, control: HTMLElementTagNameMap[K]): HTMLLabelElement {
  const label = makeElement("label");
  label.append(document.createTextNode(labelText), control);
  return label;
}

function showPreview(draft: CaptureDraft): void {
  const old = document.getElementById("answerframe-preview-host"); old?.remove();
  const host = document.createElement("div"); host.id = "answerframe-preview-host"; const shadow = host.attachShadow({ mode: "open" });
  const style = makeElement("style");
  style.textContent = previewStyles();
  const backdrop = makeElement("div", "backdrop");
  const modal = makeElement("section", "modal");
  const header = makeElement("header");
  const heading = makeElement("div");
  heading.append(makeElement("div", "eyebrow", "CAPTURE PREVIEW"), makeElement("h2", undefined, "保存到 AnswerFrame"), makeElement("p", undefined, "确认后才会上传到你的私有收藏库。"));
  const closeButton = makeElement("button", "close", "×");
  closeButton.type = "button";
  closeButton.setAttribute("data-action", "cancel");
  header.append(heading, closeButton);

  const body = makeElement("div", "body");
  const shot = makeElement("div", "shot");
  const shotImage = makeElement("img");
  shotImage.src = draft.screenshotParts[0]?.dataUrl || "";
  shotImage.alt = "回答截图预览";
  shot.append(shotImage, makeElement("span", undefined, `${draft.screenshotParts.length} page${draft.screenshotParts.length > 1 ? "s" : ""}`));
  const meta = makeElement("div", "meta");
  const questionField = makeElement("textarea");
  questionField.setAttribute("data-field", "question");
  questionField.value = draft.question;
  const titleField = makeElement("input");
  titleField.setAttribute("data-field", "title");
  titleField.value = draft.answerText.split(/\n/).find(Boolean)?.slice(0, 100) || "Saved AI answer";
  const noteField = makeElement("textarea");
  noteField.setAttribute("data-field", "note");
  noteField.placeholder = "稍后要继续聊什么？";
  const tagsField = makeElement("input");
  tagsField.setAttribute("data-field", "tags");
  tagsField.value = "ChatGPT";
  meta.append(makeField("用户问题", questionField), makeField("标题", titleField), makeField("笔记", noteField), makeField("标签", tagsField));
  body.append(shot, meta);

  const sources = makeElement("div", "sources");
  const sourceList = makeElement("div", "source-list");
  sources.append(makeElement("strong", undefined, `检测到 ${draft.links.length} 个来源`), sourceList);
  for (const link of draft.links) {
    const source = makeElement("div", "source");
    source.append(makeElement("span", "source-kind", link.kind), makeElement("span", undefined, link.label), makeElement("small", undefined, link.url || "需要补充 URL"));
    sourceList.append(source);
  }

  const footer = makeElement("footer");
  const footerNote = makeElement("span", undefined, "🔒 只上传截图和元数据");
  const footerActions = makeElement("div");
  const cancelButton = makeElement("button", "quiet", "取消");
  cancelButton.type = "button";
  cancelButton.setAttribute("data-action", "cancel");
  const confirmButton = makeElement("button", "primary", "确认并打开库");
  confirmButton.type = "button";
  confirmButton.setAttribute("data-action", "confirm");
  footerActions.append(cancelButton, confirmButton);
  footer.append(footerNote, footerActions);
  modal.append(header, body, sources, footer);
  backdrop.append(modal);
  shadow.append(style, backdrop);
  const platformTag = draft.platform === "gemini" ? "Gemini" : "ChatGPT";
  const eyebrow = shadow.querySelector<HTMLElement>(".eyebrow");
  if (eyebrow) eyebrow.textContent = `${platformTag.toUpperCase()} · CAPTURE PREVIEW`;
  tagsField.value = platformTag;
  document.documentElement.append(host);
  shadow.querySelectorAll<HTMLElement>("[data-action='cancel']").forEach((element) => element.addEventListener("click", () => host.remove()));
  shadow.querySelector("[data-action='confirm']")?.addEventListener("click", () => {
    const question = shadow.querySelector<HTMLTextAreaElement>("[data-field='question']")?.value || draft.question;
    const title = shadow.querySelector<HTMLInputElement>("[data-field='title']")?.value || "Saved AI answer";
    const note = shadow.querySelector<HTMLTextAreaElement>("[data-field='note']")?.value || "";
    const tags = (shadow.querySelector<HTMLInputElement>("[data-field='tags']")?.value || "").split(",").map((tag) => tag.trim()).filter(Boolean);
    const button = shadow.querySelector<HTMLButtonElement>("[data-action='confirm']"); if (button) { button.disabled = true; button.textContent = "正在发送到收藏库…"; }
    const enrichedDraft = { ...draft, question, _metadata: { title, note, tags } };
    void transferDraftToLibrary(enrichedDraft, host, button);
  });
}

async function transferDraftToLibrary(draft: CaptureDraft & { _metadata: { title: string; note: string; tags: string[] } }, host: HTMLElement, button: HTMLButtonElement | null): Promise<void> {
  try {
    // Persist locally before signaling the service worker. This avoids losing a
    // large screenshot when a service worker wakes slowly or the library tab is
    // still loading.
    const transfer = createDraftTransfer(draft);
    await chrome.storage.local.set({ [DRAFT_TRANSFER_KEY]: transfer });
    const response = await chrome.runtime.sendMessage({ type: "open-library-transfer", transferId: transfer.id }) as { ok?: boolean; error?: string } | undefined;
    if (!response?.ok) throw new Error(response?.error || "AnswerFrame 网页没有确认收到草稿");
    host.remove();
    showToast("已打开收藏库，请在新标签页点击“确认并保存”");
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = "确认并打开库"; }
    showToast(error instanceof Error ? error.message : "无法打开 AnswerFrame 网页", true);
  }
}

function showToast(message: string, error = false): void {
  const old = document.getElementById("answerframe-toast");
  old?.remove();
  const toast = document.createElement("div");
  toast.id = "answerframe-toast";
  toast.dataset.tone = error ? "error" : "success";
  toast.setAttribute("role", "status");
  toast.textContent = `${error ? "⚠" : "✓"} ${message}`;
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), error ? 7_000 : 4_500);
}
function previewStyles(): string { return `.backdrop{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:20px;background:rgba(16,24,40,.43);backdrop-filter:blur(7px);font-family:Arial,"Microsoft YaHei",sans-serif;color:#202d43}.modal{width:min(820px,calc(100vw - 40px));max-height:calc(100vh - 40px);overflow:auto;border-radius:16px;background:#fff;box-shadow:0 30px 90px rgba(15,25,49,.3)}header,footer{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:22px 25px;border-bottom:1px solid #e5e9f1}footer{align-items:center;border-top:1px solid #e5e9f1;border-bottom:0;background:#fbfcff}.eyebrow{color:#9aa6b7;font-size:10px;letter-spacing:.16em;font-weight:600}h2{font-size:21px;margin:7px 0 5px}p{color:#8995a6;font-size:11px;margin:0}.close{border:0;background:transparent;color:#8994a7;font-size:24px;line-height:1;cursor:pointer}.body{display:grid;grid-template-columns:1.05fr .95fr;gap:20px;padding:21px 25px}.shot{position:relative;min-height:285px;overflow:hidden;border:1px solid #dee5ef;border-radius:9px;background:#edf1f7}.shot img{display:block;width:100%;height:100%;min-height:285px;object-fit:contain}.shot span{position:absolute;right:8px;bottom:8px;color:#fff;background:rgba(20,31,53,.62);padding:4px 6px;border-radius:4px;font-size:9px}.meta{display:grid;gap:11px;align-content:start}.meta label{display:grid;gap:5px;color:#68768b;font-size:11px;font-weight:600}.meta input,.meta textarea{width:100%;resize:vertical;outline:0;border:1px solid #dfe5ee;border-radius:7px;padding:8px 9px;color:#3a4a62;background:#fcfdff;font-size:11px;font-weight:400}.sources{padding:0 25px 20px}.sources strong{display:block;color:#5d6b83;font-size:12px;margin-bottom:8px}.source-list{display:grid;gap:5px;max-height:135px;overflow:auto}.source{display:grid;grid-template-columns:54px minmax(90px,1fr) minmax(100px,1.2fr);gap:7px;align-items:center;padding:7px;border:1px solid #edf0f4;border-radius:7px;font-size:10px;color:#56657d}.source-kind{color:#6b73ce;font-size:9px}.source small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9aa5b5;font-size:9px}.quiet,.primary{border-radius:7px;padding:9px 12px;font-size:11px;font-weight:600;cursor:pointer}.quiet{border:1px solid #e1e6ef;background:#fff;color:#66758c}.primary{border:0;background:#5d65d9;color:#fff}footer>span{color:#8d99a9;font-size:10px}@media(max-width:650px){.body{grid-template-columns:1fr;padding:16px}.sources{padding:0 16px 16px}header,footer{padding:17px 16px}footer{align-items:flex-start;flex-direction:column}.shot{min-height:190px}.shot img{min-height:190px}}`; }

function bridgeLibraryMessages(): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "answerframe:forward-stored-draft") {
      void forwardStoredDraftOnce(String(message.transferId || "")).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (message?.type === "answerframe:forward-draft") {
      void forwardDraftToPage(message.draft).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    return false;
  });
  const draftId = new URL(window.location.href).searchParams.get("draftId");
  if (draftId) void forwardStoredDraftOnce(draftId);
}

function forwardStoredDraftOnce(transferId: string): Promise<{ ok: boolean; error?: string }> {
  if (acknowledgedTransferIds.has(transferId)) return Promise.resolve({ ok: true });
  const existing = storedDraftForwards.get(transferId);
  if (existing) return existing;
  const forward = forwardStoredDraftToPage(transferId).then((response) => {
    if (response.ok) acknowledgedTransferIds.add(transferId);
    return response;
  }).finally(() => storedDraftForwards.delete(transferId));
  storedDraftForwards.set(transferId, forward);
  return forward;
}

async function forwardStoredDraftToPage(transferId: string): Promise<{ ok: boolean; error?: string }> {
  if (!transferId) return { ok: false, error: "保存草稿标识缺失" };
  const stored = await chrome.storage.local.get(DRAFT_TRANSFER_KEY);
  const transfer = stored[DRAFT_TRANSFER_KEY];
  if (!isDraftTransfer(transfer, transferId)) return { ok: false, error: "保存草稿已过期，请回到 AI 页面重新确认" };
  const response = await forwardDraftToPage(transfer.draft);
  if (response.ok) {
    const latest = await chrome.storage.local.get(DRAFT_TRANSFER_KEY);
    if (isDraftTransfer(latest[DRAFT_TRANSFER_KEY], transferId)) await chrome.storage.local.remove(DRAFT_TRANSFER_KEY);
  }
  return response;
}

async function forwardDraftToPage(draft: unknown): Promise<{ ok: boolean; error?: string }> {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const requestId = `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const delivered = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onAck);
        resolve(value);
      };
      const onAck = (event: MessageEvent) => {
        if (event.source !== window || event.data?.type !== "answerframe:draft-ack" || event.data.requestId !== requestId) return;
        finish(true);
      };
      window.addEventListener("message", onAck);
      window.postMessage({ type: "answerframe:draft", draft, requestId }, "*");
      window.setTimeout(() => finish(false), 250);
    });
    if (delivered) return { ok: true };
    await delay(100);
  }
  return { ok: false, error: "AnswerFrame 网页尚未准备好" };
}

function ensurePageStyles(): void {
  if (document.getElementById("answerframe-page-style")) return;
  const style = document.createElement("style");
  style.id = "answerframe-page-style";
  const hiddenControls = adapter?.captureHideSelectors
    .map((selector) => `.answerframe-capture-mode ${selector}`)
    .join(",") || ".answerframe-capture-mode .answerframe-actions";
  style.textContent = `#answerframe-toast{position:fixed;right:22px;bottom:22px;z-index:2147483647;max-width:min(420px,calc(100vw - 44px));padding:12px 14px;border:1px solid #c8e7d0;border-radius:10px;color:#245b39;background:#f1fcf4;box-shadow:0 15px 35px rgba(29,74,50,.2);font:600 12px/1.45 Arial,"Microsoft YaHei",sans-serif}#answerframe-toast[data-tone=error]{border-color:#f0c8cc;color:#8f3640;background:#fff5f5}.answerframe-actions{display:flex;justify-content:flex-end;gap:8px;margin:8px 0 2px;opacity:.78}.answerframe-save-button{display:inline-flex;align-items:center;gap:6px;border:1px solid #d9def0;border-radius:7px;padding:6px 9px;color:#626bd5;background:#f8f8ff;font:500 11px/1.2 Arial,sans-serif;cursor:pointer;transition:.15s ease}.answerframe-save-button:hover{background:#eeefff;border-color:#bfc4f4}.answerframe-save-button:disabled{cursor:wait;opacity:.58}.answerframe-save-button[data-state=capturing]{color:#9b7a37;border-color:#efdfb7;background:#fffaf0}.answerframe-icon{font-size:16px;line-height:10px}${hiddenControls}{visibility:hidden!important}`;
  (document.head || document.documentElement).append(style);
}

if (location.hostname === "localhost" && location.port === "5173") bridgeLibraryMessages(); else { injectButtons(); observer = new MutationObserver(() => injectButtons()); observer.observe(document.body, { childList: true, subtree: true }); }
