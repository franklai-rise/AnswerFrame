import {
  type CaptureDraft,
  type ScreenshotPart,
} from "@answerframe/shared";
import { getCaptureAdapter, type CaptureAdapter } from "./adapters";
import { needsActiveTabGrant } from "./capture-permission";
import { recordDiagnostic } from "./diagnostics";

const BUTTON_CLASS = "answerframe-save-button";
const ROOT_MARK = "data-answerframe-root";
const adapter: CaptureAdapter | undefined = getCaptureAdapter(window.location);
let observer: MutationObserver | undefined;
const settledTransferIds = new Set<string>();
const pendingTransferIds = new Set<string>();
let pendingCapture: { root: Element; button: HTMLButtonElement } | undefined;

function note(stage: Parameters<typeof recordDiagnostic>[0], message: string, transferId?: string): void {
  void recordDiagnostic(stage, message, transferId).catch(() => undefined);
}

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
    button.addEventListener("click", () => {
      if (pendingCapture?.button === button) {
        showToast("请点击 Chrome 工具栏中的 AnswerFrame 图标一次，Chrome 授权后会自动继续保存", true);
        return;
      }
      void captureAnswer(root, button);
    });
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
  setSaveButtonLabel(button, "正在截取问答…");
  note("capture-started", `正在截取 ${adapter.label} 问答`);
  const questionRoot = adapter.findPreviousQuestionRoot(root);
  const captureElements = questionRoot ? [questionRoot, root] : [root];
  const scrollTarget = findScrollTarget(root);
  const originalScroll = readScrollTop(scrollTarget);
  const activeElement = document.activeElement as HTMLElement | null;
  const span = measureCaptureSpan(captureElements, scrollTarget);
  const totalHeight = span.bottom - span.top;
  const dpr = window.devicePixelRatio || 1;
  const initialHorizontal = horizontalBounds(captureElements);
  const captureRect = {
    left: initialHorizontal.left,
    top: contentYToViewportY(span.top, scrollTarget),
    width: initialHorizontal.width,
    height: totalHeight,
  };
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
    const viewport = captureViewport(scrollTarget);
    const segmentHeight = Math.min(Math.max(1, viewport.bottom - viewport.top), 1200);
    const crops: string[] = [];
    for (let offset = 0; offset < totalHeight; offset += segmentHeight) {
      const segmentTop = span.top + offset;
      const segmentBottom = Math.min(span.bottom, segmentTop + segmentHeight);
      writeScrollTop(scrollTarget, Math.max(0, segmentTop));
      // captureVisibleTab is limited to two calls per second. Waiting here also
      // gives ChatGPT/Gemini time to finish rendering after each scroll.
      await delay(560);
      const currentViewport = captureViewport(scrollTarget);
      const currentHorizontal = horizontalBounds(captureElements);
      const top = Math.max(currentViewport.top, contentYToViewportY(segmentTop, scrollTarget));
      const bottom = Math.min(currentViewport.bottom, contentYToViewportY(segmentBottom, scrollTarget));
      if (bottom <= top) continue;
      const capture = await chrome.runtime.sendMessage({ type: "capture-visible" }) as { dataUrl?: string; error?: string };
      if (capture?.error || !capture?.dataUrl) throw new Error(capture?.error || "截图失败");
      crops.push(await cropDataUrl(capture.dataUrl, {
        left: currentHorizontal.left,
        top,
        width: currentHorizontal.width,
        height: bottom - top,
      }, dpr));
    }
    const screenshotParts = await createScreenshotParts(crops, 1600);
    const draft: CaptureDraft = {
      platform: adapter.platform,
      conversationUrl: window.location.href,
      question,
      answerText,
      theme,
      screenshotParts,
      links: assignLinksToScreenshotParts(links, screenshotParts),
    };
    setSaveButtonLabel(button, "正在打开预览…");
    note("preview-ready", `已截取完整问答，检测到 ${links.length} 个来源`);
    showPreview(draft);
  } catch (error) {
    const message = error instanceof Error ? error.message : `捕获失败；请保持 ${adapter.label} 标签页可见后重试`;
    if (needsActiveTabGrant(error)) {
      pendingCapture = { root, button };
      note("capture-awaiting-permission", "等待用户点击扩展图标授予当前标签页截图权限");
      showToast("请点击 Chrome 工具栏中的 AnswerFrame 图标一次；授权后会自动继续保存此回答", true);
    } else {
      note("save-failed", message);
      showToast(message, true);
    }
  } finally {
    document.documentElement.classList.remove("answerframe-capture-mode");
    writeScrollTop(scrollTarget, originalScroll);
    activeElement?.focus({ preventScroll: true });
    button.disabled = false;
    delete button.dataset.state;
    setSaveButtonLabel(button, pendingCapture?.button === button ? "点击工具栏图标授权" : "Save to AnswerFrame");
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

function scrollViewportTop(target: Element | Window): number {
  if (target === window) return 0;
  const element = target as HTMLElement;
  return element.getBoundingClientRect().top + element.clientTop;
}

function elementContentTop(element: Element, target: Element | Window): number {
  return element.getBoundingClientRect().top - scrollViewportTop(target) + readScrollTop(target);
}

function contentYToViewportY(contentY: number, target: Element | Window): number {
  return scrollViewportTop(target) + contentY - readScrollTop(target);
}

function elementContentHeight(element: Element): number {
  const htmlElement = element as HTMLElement;
  const rect = htmlElement.getBoundingClientRect();
  return Math.max(rect.height, htmlElement.scrollHeight || 0);
}

function measureCaptureSpan(elements: Element[], target: Element | Window): { top: number; bottom: number } {
  const tops = elements.map((element) => elementContentTop(element, target));
  const bottoms = elements.map((element, index) => tops[index] + elementContentHeight(element));
  return { top: Math.min(...tops), bottom: Math.max(...bottoms) };
}

function captureViewport(target: Element | Window): { top: number; bottom: number } {
  if (target === window) return { top: 0, bottom: window.innerHeight };
  const element = target as HTMLElement;
  const rect = element.getBoundingClientRect();
  const top = Math.max(0, rect.top + element.clientTop);
  return { top, bottom: Math.min(window.innerHeight, top + element.clientHeight) };
}

function horizontalBounds(elements: Element[]): { left: number; width: number } {
  const rects = elements.map((element) => element.getBoundingClientRect());
  const left = Math.max(0, Math.min(...rects.map((rect) => rect.left)));
  const right = Math.min(window.innerWidth, Math.max(...rects.map((rect) => rect.right)));
  return { left, width: Math.max(1, right - left) };
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

/**
 * Keep every captured viewport as an independent WebP part.  This makes each
 * Port message small and lets the service worker persist a part before the
 * next one is sent, instead of trying to relay one giant stitched screenshot.
 */
async function createScreenshotParts(crops: string[], maxWidth: number): Promise<ScreenshotPart[]> {
  if (!crops.length) throw new Error("没有捕获到问答区域");
  return Promise.all(crops.map(async (crop, pageIndex) => {
    const image = await loadImage(crop);
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const scale = Math.min(1, maxWidth / Math.max(1, sourceWidth));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持截图处理");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { pageIndex, dataUrl: canvas.toDataURL("image/webp", .9), width: canvas.width, height: canvas.height };
  }));
}

function assignLinksToScreenshotParts(links: CaptureDraft["links"], parts: ScreenshotPart[]): CaptureDraft["links"] {
  const totalHeight = Math.max(1, parts.reduce((total, part) => total + part.height, 0));
  return links.map((link) => {
    const absoluteY = Math.max(0, Math.min(totalHeight - 1, link.anchor.y * totalHeight));
    let pageIndex = 0;
    let pageTop = 0;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (absoluteY < pageTop + part.height || index === parts.length - 1) { pageIndex = part.pageIndex; break; }
      pageTop += part.height;
    }
    const part = parts.find((item) => item.pageIndex === pageIndex) || parts[0];
    return {
      ...link,
      pageIndex,
      anchor: {
        ...link.anchor,
        y: Math.max(0, Math.min(1, (absoluteY - pageTop) / Math.max(1, part.height))),
        height: Math.max(0, Math.min(1, (link.anchor.height * totalHeight) / Math.max(1, part.height))),
      },
    };
  });
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
  for (const [index, part] of draft.screenshotParts.entries()) {
    const shotImage = makeElement("img");
    shotImage.src = part.dataUrl;
    shotImage.alt = `完整问答截图预览，第 ${index + 1} 页`;
    shotImage.title = "点击放大查看";
    shotImage.addEventListener("click", () => showPreviewImageViewer(shadow, draft.screenshotParts, index));
    shot.append(shotImage);
  }
  shot.append(makeElement("span", undefined, `${draft.screenshotParts.length} page${draft.screenshotParts.length > 1 ? "s" : ""}`));
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
  const confirmButton = makeElement("button", "primary", "确认并保存");
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
    const button = shadow.querySelector<HTMLButtonElement>("[data-action='confirm']"); if (button) { button.disabled = true; button.textContent = "正在保存到收藏库…"; }
    shadow.querySelectorAll<HTMLButtonElement>("[data-action='cancel']").forEach((control) => { control.disabled = true; });
    const enrichedDraft = { ...draft, question, _metadata: { title, note, tags } };
    void uploadDraftToNativeLibrary(enrichedDraft, host, button);
  });
}

function showPreviewImageViewer(shadow: ShadowRoot, parts: ScreenshotPart[], initialIndex: number): void {
  shadow.getElementById("answerframe-image-viewer")?.remove();
  let index = initialIndex;
  let scale = 1;
  let offset = { x: 0, y: 0 };
  let drag: { pointerId: number; x: number; y: number; originX: number; originY: number } | undefined;
  const viewer = makeElement("div", "image-viewer");
  viewer.id = "answerframe-image-viewer";
  const viewerStyle = makeElement("style");
  viewerStyle.textContent = `.image-viewer{position:fixed;inset:0;z-index:2147483647;overflow:hidden;color:#fff;background:rgba(7,11,20,.96);font-family:Arial,"Microsoft YaHei",sans-serif}.viewer-toolbar{position:absolute;z-index:3;inset:15px 18px auto;display:flex;align-items:center;justify-content:space-between;pointer-events:none}.viewer-toolbar>span,.viewer-help{padding:7px 10px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(24,31,45,.8);font-size:11px}.viewer-toolbar>div{display:flex;gap:5px;pointer-events:auto}.viewer-toolbar button,.viewer-page{display:grid;place-items:center;border:1px solid rgba(255,255,255,.14);border-radius:8px;color:#fff;background:rgba(24,31,45,.8);cursor:pointer}.viewer-toolbar button{width:38px;height:38px;font-size:18px}.viewer-canvas{position:absolute;inset:0;display:grid;place-items:center;overflow:hidden;cursor:grab;touch-action:none;user-select:none}.viewer-canvas.dragging{cursor:grabbing}.viewer-canvas img{display:block;max-width:calc(100vw - 120px);max-height:calc(100vh - 105px);object-fit:contain;transform-origin:center;will-change:transform;box-shadow:0 15px 55px rgba(0,0,0,.45);-webkit-user-drag:none}.viewer-page{position:absolute;z-index:3;top:50%;width:44px;height:56px;transform:translateY(-50%);font-size:25px}.viewer-page.previous{left:18px}.viewer-page.next{right:18px}.viewer-page:disabled{opacity:.25;cursor:default}.viewer-help{position:absolute;z-index:3;left:50%;bottom:15px;transform:translateX(-50%);white-space:nowrap;color:rgba(255,255,255,.8)}`;
  const toolbar = makeElement("div", "viewer-toolbar");
  const status = makeElement("span");
  const controls = makeElement("div");
  const zoomOut = makeElement("button", undefined, "−");
  const resetButton = makeElement("button", undefined, "↺");
  const zoomIn = makeElement("button", undefined, "+");
  const closeButton = makeElement("button", undefined, "×");
  zoomOut.title = "缩小"; resetButton.title = "恢复适合窗口"; zoomIn.title = "放大"; closeButton.title = "关闭";
  controls.append(zoomOut, resetButton, zoomIn, closeButton);
  toolbar.append(status, controls);
  const canvas = makeElement("div", "viewer-canvas");
  const image = makeElement("img");
  canvas.append(image);
  const previous = makeElement("button", "viewer-page previous", "‹");
  const next = makeElement("button", "viewer-page next", "›");
  const help = makeElement("div", "viewer-help", "滚轮缩放 · 拖拽移动 · 双击复位 · Esc 关闭");
  viewer.append(viewerStyle, toolbar, canvas, previous, next, help);
  shadow.append(viewer);

  const render = () => {
    const nextSource = parts[index]?.dataUrl || "";
    if (image.src !== nextSource) image.src = nextSource;
    image.alt = `问答截图第 ${index + 1} 页`;
    image.style.transform = `translate3d(${offset.x}px,${offset.y}px,0) scale(${scale})`;
    status.textContent = `第 ${index + 1} / ${parts.length} 页 · ${Math.round(scale * 100)}%`;
    previous.disabled = index === 0;
    next.disabled = index === parts.length - 1;
  };
  const reset = () => { scale = 1; offset = { x: 0, y: 0 }; render(); };
  const setScale = (value: number) => { scale = Math.max(.5, Math.min(6, value)); render(); };
  const setPage = (value: number) => { index = Math.max(0, Math.min(parts.length - 1, value)); reset(); };
  const close = () => { window.removeEventListener("keydown", onKeyDown, true); viewer.remove(); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "+" || event.key === "=") setScale(scale * 1.2);
    else if (event.key === "-") setScale(scale / 1.2);
    else if (event.key === "0") reset();
    else if (event.key === "ArrowLeft") setPage(index - 1);
    else if (event.key === "ArrowRight") setPage(index + 1);
  };
  zoomOut.addEventListener("click", () => setScale(scale / 1.2));
  resetButton.addEventListener("click", reset);
  zoomIn.addEventListener("click", () => setScale(scale * 1.2));
  closeButton.addEventListener("click", close);
  previous.addEventListener("click", () => setPage(index - 1));
  next.addEventListener("click", () => setPage(index + 1));
  canvas.addEventListener("wheel", (event) => { event.preventDefault(); setScale(scale * (event.deltaY < 0 ? 1.12 : .89)); }, { passive: false });
  canvas.addEventListener("dblclick", reset);
  canvas.addEventListener("pointerdown", (event) => { drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: offset.x, originY: offset.y }; canvas.classList.add("dragging"); canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener("pointermove", (event) => { if (!drag || drag.pointerId !== event.pointerId) return; offset = { x: drag.originX + event.clientX - drag.x, y: drag.originY + event.clientY - drag.y }; render(); });
  const endDrag = () => { drag = undefined; canvas.classList.remove("dragging"); };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  window.addEventListener("keydown", onKeyDown, true);
  render();
}

type NativeUploadAck = { type?: string; requestId?: string; ok?: boolean; error?: string; clipId?: string };

function makeNativeUploadId(): string {
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `clip-${suffix}`;
}

function sendUploadRequest(port: chrome.runtime.Port, payload: Record<string, unknown>): Promise<NativeUploadAck> {
  const requestId = `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error("保存请求超时，请重新尝试")), 45_000);
    const onMessage = (message: NativeUploadAck) => {
      if (message?.type !== "ack" || message.requestId !== requestId) return;
      if (!message.ok) finish(new Error(message.error || "保存失败"));
      else finish(null, message);
    };
    const onDisconnect = () => finish(new Error(chrome.runtime.lastError?.message || "AnswerFrame 保存连接已断开"));
    const finish = (error: Error | null, response?: NativeUploadAck) => {
      window.clearTimeout(timeout);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      if (error) reject(error); else resolve(response || { ok: true });
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    try {
      port.postMessage({ ...payload, requestId });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function uploadDraftToNativeLibrary(draft: CaptureDraft & { _metadata: { title: string; note: string; tags: string[] } }, host: HTMLElement, button: HTMLButtonElement | null): Promise<void> {
  const uploadId = makeNativeUploadId();
  let port: chrome.runtime.Port | undefined;
  let began = false;
  try {
    pendingTransferIds.add(uploadId);
    port = chrome.runtime.connect({ name: "answerframe-native-upload" });
    const metadata = {
      platform: draft.platform,
      conversationUrl: draft.conversationUrl,
      question: draft.question,
      answerText: draft.answerText,
      theme: draft.theme,
      links: draft.links,
      title: draft._metadata.title,
      note: draft._metadata.note,
      tags: draft._metadata.tags,
      expectedParts: draft.screenshotParts.length,
    };
    await sendUploadRequest(port, { type: "begin", uploadId, metadata });
    began = true;
    for (const part of draft.screenshotParts) await sendUploadRequest(port, { type: "part", uploadId, part });
    const result = await sendUploadRequest(port, { type: "commit", uploadId, openLibrary: true });
    pendingTransferIds.delete(uploadId);
    settledTransferIds.add(uploadId);
    note("save-succeeded", "已成功保存到 AnswerFrame", uploadId);
    host.remove();
    showToast(result.clipId ? "已成功保存到 AnswerFrame，正在打开收藏库" : "已成功保存到 AnswerFrame");
  } catch (error) {
    pendingTransferIds.delete(uploadId);
    if (began && port) {
      try { await sendUploadRequest(port, { type: "abort", uploadId }); } catch { /* stale chunks are garbage-collected by the worker */ }
    }
    if (button) { button.disabled = false; button.textContent = "确认并保存"; }
    host.shadowRoot?.querySelectorAll<HTMLButtonElement>("[data-action='cancel']").forEach((control) => { control.disabled = false; });
    const message = error instanceof Error ? error.message : "无法保存到 AnswerFrame";
    note("save-failed", message);
    showToast(message, true);
  } finally {
    port?.disconnect();
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "answerframe:resume-pending-capture") {
    const pending = pendingCapture;
    if (!pending || !pending.root.isConnected) {
      pendingCapture = undefined;
      sendResponse({ ok: false, pending: false });
      return false;
    }
    pendingCapture = undefined;
    showToast("已获得截图权限，正在继续保存…");
    void captureAnswer(pending.root, pending.button);
    sendResponse({ ok: true, pending: true });
    return false;
  }
  if (message?.type !== "answerframe:save-result") return false;
  const transferId = String(message.transferId || "");
  if (transferId && pendingTransferIds.has(transferId)) return false;
  if (transferId && settledTransferIds.has(transferId)) return false;
  const ok = message.ok === true;
  if (transferId) settledTransferIds.add(transferId);
  const messageText = ok ? "已成功保存到 AnswerFrame" : String(message.error || "保存失败，请重新尝试");
  note(ok ? "save-succeeded" : "save-failed", messageText, transferId || undefined);
  showToast(messageText, !ok);
  return false;
});

function previewStyles(): string { return `.backdrop{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:20px;background:rgba(16,24,40,.43);backdrop-filter:blur(7px);font-family:Arial,"Microsoft YaHei",sans-serif;color:#202d43}.modal{width:min(820px,calc(100vw - 40px));max-height:calc(100vh - 40px);overflow:auto;border-radius:16px;background:#fff;box-shadow:0 30px 90px rgba(15,25,49,.3)}header,footer{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:22px 25px;border-bottom:1px solid #e5e9f1}footer{align-items:center;border-top:1px solid #e5e9f1;border-bottom:0;background:#fbfcff}.eyebrow{color:#9aa6b7;font-size:10px;letter-spacing:.16em;font-weight:600}h2{font-size:21px;margin:7px 0 5px}p{color:#8995a6;font-size:11px;margin:0}.close{border:0;background:transparent;color:#8994a7;font-size:24px;line-height:1;cursor:pointer}.body{display:grid;grid-template-columns:1.05fr .95fr;gap:20px;padding:21px 25px}.shot{position:relative;min-height:285px;max-height:420px;overflow:auto;border:1px solid #dee5ef;border-radius:9px;background:#edf1f7}.shot img{display:block;width:100%;height:auto;min-height:0;object-fit:contain;cursor:zoom-in}.shot img+img{border-top:1px solid #d6dce7}.shot span{position:sticky;display:block;width:max-content;margin:-26px 8px 8px auto;bottom:8px;color:#fff;background:rgba(20,31,53,.62);padding:4px 6px;border-radius:4px;font-size:9px}.meta{display:grid;gap:11px;align-content:start}.meta label{display:grid;gap:5px;color:#68768b;font-size:11px;font-weight:600}.meta input,.meta textarea{width:100%;resize:vertical;outline:0;border:1px solid #dfe5ee;border-radius:7px;padding:8px 9px;color:#3a4a62;background:#fcfdff;font-size:11px;font-weight:400}.sources{padding:0 25px 20px}.sources strong{display:block;color:#5d6b83;font-size:12px;margin-bottom:8px}.source-list{display:grid;gap:5px;max-height:135px;overflow:auto}.source{display:grid;grid-template-columns:54px minmax(90px,1fr) minmax(100px,1.2fr);gap:7px;align-items:center;padding:7px;border:1px solid #edf0f4;border-radius:7px;font-size:10px;color:#56657d}.source-kind{color:#6b73ce;font-size:9px}.source small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9aa5b5;font-size:9px}.quiet,.primary{border-radius:7px;padding:9px 12px;font-size:11px;font-weight:600;cursor:pointer}.quiet{border:1px solid #e1e6ef;background:#fff;color:#66758c}.primary{border:0;background:#5d65d9;color:#fff}footer>span{color:#8d99a9;font-size:10px}@media(max-width:650px){.body{grid-template-columns:1fr;padding:16px}.sources{padding:0 16px 16px}header,footer{padding:17px 16px}footer{align-items:flex-start;flex-direction:column}.shot{min-height:190px}.shot img{min-height:0}}`; }

function ensurePageStyles(): void {
  if (document.getElementById("answerframe-page-style")) return;
  const style = document.createElement("style");
  style.id = "answerframe-page-style";
  const hiddenControls = [
    ".answerframe-capture-mode .answerframe-actions",
    ...(adapter?.captureHideSelectors || []).map((selector) => `.answerframe-capture-mode ${selector}`),
  ].join(",");
  style.textContent = `#answerframe-toast{position:fixed;right:22px;bottom:22px;z-index:2147483647;max-width:min(420px,calc(100vw - 44px));padding:12px 14px;border:1px solid #c8e7d0;border-radius:10px;color:#245b39;background:#f1fcf4;box-shadow:0 15px 35px rgba(29,74,50,.2);font:600 12px/1.45 Arial,"Microsoft YaHei",sans-serif}#answerframe-toast[data-tone=error]{border-color:#f0c8cc;color:#8f3640;background:#fff5f5}.answerframe-actions{display:flex;justify-content:flex-end;gap:8px;margin:8px 0 2px;opacity:.78}.answerframe-save-button{display:inline-flex;align-items:center;gap:6px;border:1px solid #d9def0;border-radius:7px;padding:6px 9px;color:#626bd5;background:#f8f8ff;font:500 11px/1.2 Arial,sans-serif;cursor:pointer;transition:.15s ease}.answerframe-save-button:hover{background:#eeefff;border-color:#bfc4f4}.answerframe-save-button:disabled{cursor:wait;opacity:.58}.answerframe-save-button[data-state=capturing]{color:#9b7a37;border-color:#efdfb7;background:#fffaf0}.answerframe-icon{font-size:16px;line-height:10px}${hiddenControls}{visibility:hidden!important}`;
  (document.head || document.documentElement).append(style);
}

injectButtons();
observer = new MutationObserver(() => injectButtons());
observer.observe(document.body, { childList: true, subtree: true });
