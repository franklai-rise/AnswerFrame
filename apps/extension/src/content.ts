import {
  extractLinksFromRoot,
  type CaptureDraft,
  type ScreenshotPart,
} from "@answerframe/shared";

const BUTTON_CLASS = "answerframe-save-button";
const ROOT_MARK = "data-answerframe-root";
let observer: MutationObserver | undefined;

function answerRoots(): Element[] {
  // ChatGPT has used several wrappers for a conversation turn over time. Keep
  // the selector attribute-based so utility-class names containing slashes
  // cannot turn it into invalid CSS.
  const candidates = Array.from(document.querySelectorAll(
    "[data-message-author-role='assistant'], [data-testid='conversation-turn'], [data-message-id], article, [class*='conversation-turn']",
  ));
  const roots: Element[] = [];
  for (const candidate of candidates) {
    const text = (candidate.textContent || "").trim();
    if (!text || text.length < 20) continue;
    const roleNode = candidate.matches("[data-message-author-role]")
      ? candidate
      : candidate.querySelector("[data-message-author-role]");
    const role = roleNode?.getAttribute("data-message-author-role");
    if (role !== "assistant") continue;
    const markdown = candidate.querySelector(".markdown, [class*='markdown']");
    const root = markdown?.closest("[data-message-author-role='assistant'], article") || candidate;
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

function injectButtons(): void {
  ensurePageStyles();
  for (const root of answerRoots()) {
    if (root.querySelector(`.${BUTTON_CLASS}`)) continue;
    root.setAttribute(ROOT_MARK, "true");
    const actionBar = document.createElement("div");
    actionBar.className = "answerframe-actions";
    const button = document.createElement("button");
    button.className = BUTTON_CLASS;
    button.type = "button";
    button.innerHTML = "<span class=\"answerframe-icon\">⌁</span><span>Save to AnswerFrame</span>";
    button.addEventListener("click", () => void captureAnswer(root, button));
    actionBar.append(button);
    root.append(actionBar);
  }
}

async function captureAnswer(root: Element, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.dataset.state = "capturing";
  const scrollTarget = findScrollTarget(root);
  const originalScroll = readScrollTop(scrollTarget);
  const activeElement = document.activeElement as HTMLElement | null;
  const rootRect = (root as HTMLElement).getBoundingClientRect();
  const totalHeight = Math.max((root as HTMLElement).scrollHeight || rootRect.height, rootRect.height);
  const rootTop = rootRect.top + originalScroll;
  const dpr = window.devicePixelRatio || 1;
  const theme = document.documentElement.classList.contains("dark") || getComputedStyle(document.body).backgroundColor === "rgb(52, 53, 65)" ? "dark" : "light";
  const links = extractLinksFromRoot(root, { rootRect: { left: rootRect.left, top: rootRect.top, width: rootRect.width, height: totalHeight } });
  const answerText = (root.querySelector(".markdown, [class*='markdown']")?.textContent || root.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  const question = findPreviousQuestion(root);
  document.documentElement.classList.add("answerframe-capture-mode");
  try {
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
    const draft: CaptureDraft = { platform: "chatgpt", conversationUrl: window.location.href, question, answerText, theme, screenshotParts, links };
    showPreview(draft);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "捕获失败；请保持 ChatGPT 标签页可见后重试", true);
  } finally {
    document.documentElement.classList.remove("answerframe-capture-mode");
    writeScrollTop(scrollTarget, originalScroll);
    activeElement?.focus({ preventScroll: true });
    button.disabled = false;
    delete button.dataset.state;
  }
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

function findPreviousQuestion(root: Element): string {
  const all = Array.from(document.querySelectorAll("[data-message-author-role='user'], [data-message-author-role='assistant']"));
  const index = all.findIndex((item) => item === root || item.contains(root) || root.contains(item));
  for (let i = index - 1; i >= 0; i -= 1) {
    if (all[i].getAttribute("data-message-author-role") === "user") return (all[i].textContent || "").replace(/\s+/g, " ").trim();
  }
  return "";
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

function showPreview(draft: CaptureDraft): void {
  const old = document.getElementById("answerframe-preview-host"); old?.remove();
  const host = document.createElement("div"); host.id = "answerframe-preview-host"; const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${previewStyles()}</style><div class="backdrop"><section class="modal"><header><div><div class="eyebrow">CAPTURE PREVIEW</div><h2>保存到 AnswerFrame</h2><p>确认后才会上传到你的私有收藏库。</p></div><button class="close" data-action="cancel">×</button></header><div class="body"><div class="shot"><img src="${escapeHtml(draft.screenshotParts[0]?.dataUrl || "")}" /><span>${draft.screenshotParts.length} page${draft.screenshotParts.length > 1 ? "s" : ""}</span></div><div class="meta"><label>用户问题<textarea data-field="question">${escapeHtml(draft.question)}</textarea></label><label>标题<input data-field="title" value="${escapeHtml(draft.answerText.split(/\n/).find(Boolean)?.slice(0, 100) || "Saved AI answer")}" /></label><label>笔记<textarea data-field="note" placeholder="稍后要继续聊什么？"></textarea></label><label>标签<input data-field="tags" value="ChatGPT" /></label></div></div><div class="sources"><strong>检测到 ${draft.links.length} 个来源</strong><div class="source-list">${draft.links.map((link) => `<div class="source"><span class="source-kind">${escapeHtml(link.kind)}</span><span>${escapeHtml(link.label)}</span><small>${escapeHtml(link.url || "需要补充 URL")}</small></div>`).join("")}</div></div><footer><span>🔒 只上传截图和元数据</span><div><button class="quiet" data-action="cancel">取消</button><button class="primary" data-action="confirm">确认并打开库</button></div></footer></section></div>`;
  document.documentElement.append(host);
  shadow.querySelectorAll<HTMLElement>("[data-action='cancel']").forEach((element) => element.addEventListener("click", () => host.remove()));
  shadow.querySelector("[data-action='confirm']")?.addEventListener("click", () => {
    const question = shadow.querySelector<HTMLTextAreaElement>("[data-field='question']")?.value || draft.question;
    const title = shadow.querySelector<HTMLInputElement>("[data-field='title']")?.value || "Saved AI answer";
    const note = shadow.querySelector<HTMLTextAreaElement>("[data-field='note']")?.value || "";
    const tags = (shadow.querySelector<HTMLInputElement>("[data-field='tags']")?.value || "").split(",").map((tag) => tag.trim()).filter(Boolean);
    const button = shadow.querySelector<HTMLButtonElement>("[data-action='confirm']"); if (button) { button.disabled = true; button.textContent = "正在打开…"; }
    const enrichedDraft = { ...draft, question, _metadata: { title, note, tags } };
    void chrome.runtime.sendMessage({ type: "open-library-with-draft", draft: enrichedDraft }).then((response) => { if (response?.error) showToast(response.error, true); else host.remove(); });
    void chrome.storage.local.set({ answerframeLastDraft: { ...draft, question, _metadata: { title, note, tags } } });
  });
}

function showToast(message: string, error = false): void { const old = document.getElementById("answerframe-toast"); old?.remove(); const toast = document.createElement("div"); toast.id = "answerframe-toast"; toast.textContent = `${error ? "⚠" : "✓"} ${message}`; document.body.append(toast); window.setTimeout(() => toast.remove(), 4000); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[character] || character)); }
function previewStyles(): string { return `.backdrop{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:20px;background:rgba(16,24,40,.43);backdrop-filter:blur(7px);font-family:Arial,"Microsoft YaHei",sans-serif;color:#202d43}.modal{width:min(820px,calc(100vw - 40px));max-height:calc(100vh - 40px);overflow:auto;border-radius:16px;background:#fff;box-shadow:0 30px 90px rgba(15,25,49,.3)}header,footer{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:22px 25px;border-bottom:1px solid #e5e9f1}footer{align-items:center;border-top:1px solid #e5e9f1;border-bottom:0;background:#fbfcff}.eyebrow{color:#9aa6b7;font-size:10px;letter-spacing:.16em;font-weight:600}h2{font-size:21px;margin:7px 0 5px}p{color:#8995a6;font-size:11px;margin:0}.close{border:0;background:transparent;color:#8994a7;font-size:24px;line-height:1;cursor:pointer}.body{display:grid;grid-template-columns:1.05fr .95fr;gap:20px;padding:21px 25px}.shot{position:relative;min-height:285px;overflow:hidden;border:1px solid #dee5ef;border-radius:9px;background:#edf1f7}.shot img{display:block;width:100%;height:100%;min-height:285px;object-fit:contain}.shot span{position:absolute;right:8px;bottom:8px;color:#fff;background:rgba(20,31,53,.62);padding:4px 6px;border-radius:4px;font-size:9px}.meta{display:grid;gap:11px;align-content:start}.meta label{display:grid;gap:5px;color:#68768b;font-size:11px;font-weight:600}.meta input,.meta textarea{width:100%;resize:vertical;outline:0;border:1px solid #dfe5ee;border-radius:7px;padding:8px 9px;color:#3a4a62;background:#fcfdff;font-size:11px;font-weight:400}.sources{padding:0 25px 20px}.sources strong{display:block;color:#5d6b83;font-size:12px;margin-bottom:8px}.source-list{display:grid;gap:5px;max-height:135px;overflow:auto}.source{display:grid;grid-template-columns:54px minmax(90px,1fr) minmax(100px,1.2fr);gap:7px;align-items:center;padding:7px;border:1px solid #edf0f4;border-radius:7px;font-size:10px;color:#56657d}.source-kind{color:#6b73ce;font-size:9px}.source small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9aa5b5;font-size:9px}.quiet,.primary{border-radius:7px;padding:9px 12px;font-size:11px;font-weight:600;cursor:pointer}.quiet{border:1px solid #e1e6ef;background:#fff;color:#66758c}.primary{border:0;background:#5d65d9;color:#fff}footer>span{color:#8d99a9;font-size:10px}@media(max-width:650px){.body{grid-template-columns:1fr;padding:16px}.sources{padding:0 16px 16px}header,footer{padding:17px 16px}footer{align-items:flex-start;flex-direction:column}.shot{min-height:190px}.shot img{min-height:190px}}`; }

function bridgeLibraryMessages(): void { chrome.runtime.onMessage.addListener((message) => { if (message?.type === "answerframe:forward-draft") window.postMessage({ type: "answerframe:draft", draft: message.draft }, "*"); }); }

function ensurePageStyles(): void {
  if (document.getElementById("answerframe-page-style")) return;
  const style = document.createElement("style");
  style.id = "answerframe-page-style";
  style.textContent = `.answerframe-actions{display:flex;justify-content:flex-end;gap:8px;margin:8px 0 2px;opacity:.78}.answerframe-save-button{display:inline-flex;align-items:center;gap:6px;border:1px solid #d9def0;border-radius:7px;padding:6px 9px;color:#626bd5;background:#f8f8ff;font:500 11px/1.2 Arial,sans-serif;cursor:pointer;transition:.15s ease}.answerframe-save-button:hover{background:#eeefff;border-color:#bfc4f4}.answerframe-save-button:disabled{cursor:wait;opacity:.58}.answerframe-save-button[data-state=capturing]{color:#9b7a37;border-color:#efdfb7;background:#fffaf0}.answerframe-icon{font-size:16px;line-height:10px}.answerframe-capture-mode .answerframe-actions,.answerframe-capture-mode button[aria-label*="Copy"],.answerframe-capture-mode button[aria-label*="复制"],.answerframe-capture-mode [data-testid*="copy"],.answerframe-capture-mode [data-testid*="feedback"]{visibility:hidden!important}`;
  (document.head || document.documentElement).append(style);
}

if (location.hostname === "localhost" && location.port === "5173") bridgeLibraryMessages(); else { injectButtons(); observer = new MutationObserver(() => injectButtons()); observer.observe(document.body, { childList: true, subtree: true }); }
