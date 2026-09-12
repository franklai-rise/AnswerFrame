import { recordDiagnostic } from "./diagnostics";
import {
  abortNativeUpload,
  beginNativeUpload,
  cleanupStaleNativeUploads,
  commitNativeUpload,
  type NativeUploadMetadata,
  type NativeUploadPart,
  writeNativeUploadPart,
} from "./native-store";

const NATIVE_UPLOAD_PORT = "answerframe-native-upload";
const LIBRARY_URL = "library.html";
let lastCaptureAt = 0;

function note(stage: Parameters<typeof recordDiagnostic>[0], message: string, transferId?: string): void {
  void recordDiagnostic(stage, message, transferId).catch(() => undefined);
}

void cleanupStaleNativeUploads().catch(() => undefined);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "capture-visible") {
    void captureVisible(sender.tab?.windowId).then(sendResponse).catch((error) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "open-native-library") {
    void openNativeLibrary().then((tab) => sendResponse({ ok: true, tabId: tab.id })).catch((error) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "auth-google") {
    void authenticateWithOffscreen().then(sendResponse).catch((error) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== NATIVE_UPLOAD_PORT) return;
  const sourceTabId = port.sender?.tab?.id;
  port.onMessage.addListener((message) => {
    void handleNativeUploadMessage(port, sourceTabId, message);
  });
});

/**
 * `captureVisibleTab` needs Chrome's activeTab grant.  An injected page button
 * cannot create that grant, but this explicit toolbar click can.  If a save
 * was waiting for it, resume that exact answer; otherwise the icon retains its
 * normal role of opening the library.
 */
chrome.action.onClicked.addListener((tab) => {
  void handleActionClick(tab).catch((error) => {
    note("save-failed", error instanceof Error ? error.message : "无法处理扩展图标操作");
  });
});

async function handleActionClick(tab: chrome.tabs.Tab): Promise<void> {
  if (typeof tab.id === "number") {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "answerframe:resume-pending-capture" }) as { pending?: boolean } | undefined;
      if (response?.pending) return;
    } catch {
      // A normal webpage has no AnswerFrame content script. Open the library.
    }
  }
  await openNativeLibrary();
}

async function handleNativeUploadMessage(port: chrome.runtime.Port, sourceTabId: number | undefined, message: unknown): Promise<void> {
  const candidate = message as { type?: unknown; requestId?: unknown; uploadId?: unknown; metadata?: unknown; part?: unknown; openLibrary?: unknown };
  const requestId = typeof candidate?.requestId === "string" ? candidate.requestId : "";
  const uploadId = typeof candidate?.uploadId === "string" ? candidate.uploadId : "";
  if (!requestId || !uploadId || typeof candidate?.type !== "string") {
    port.postMessage({ type: "ack", requestId, ok: false, error: "保存请求格式无效" });
    return;
  }
  try {
    if (candidate.type === "begin") {
      await beginNativeUpload(uploadId, candidate.metadata as NativeUploadMetadata, sourceTabId);
      note("draft-stored", "正在把截图写入扩展本地资料库", uploadId);
      port.postMessage({ type: "ack", requestId, ok: true });
      return;
    }
    if (candidate.type === "part") {
      await writeNativeUploadPart(uploadId, candidate.part as NativeUploadPart);
      port.postMessage({ type: "ack", requestId, ok: true });
      return;
    }
    if (candidate.type === "abort") {
      await abortNativeUpload(uploadId);
      note("save-failed", "已取消未完成的保存", uploadId);
      port.postMessage({ type: "ack", requestId, ok: true });
      return;
    }
    if (candidate.type === "commit") {
      const { clip, sourceTabId: storedSourceTabId } = await commitNativeUpload(uploadId);
      note("save-succeeded", "回答已保存到扩展本地资料库", uploadId);
      if (candidate.openLibrary !== false) {
        try { await openNativeLibrary(); } catch (error) {
          // A newly saved clip remains usable even if Chrome declines to open a
          // new tab (for example while the browser is shutting down).
          note("library-opened", error instanceof Error ? `已保存；收藏库未自动打开：${error.message}` : "已保存；收藏库未自动打开", uploadId);
        }
      }
      const targetTabId = storedSourceTabId ?? sourceTabId;
      if (typeof targetTabId === "number") {
        void chrome.tabs.sendMessage(targetTabId, { type: "answerframe:save-result", transferId: uploadId, ok: true, clipId: clip.id }).catch(() => undefined);
      }
      port.postMessage({ type: "ack", requestId, ok: true, clipId: clip.id });
      return;
    }
    throw new Error("未知的保存操作");
  } catch (error) {
    const description = error instanceof Error ? error.message : String(error);
    note("save-failed", description, uploadId || undefined);
    port.postMessage({ type: "ack", requestId, ok: false, error: description });
  }
}

async function captureVisible(windowId?: number): Promise<{ dataUrl?: string; error?: string }> {
  if (typeof windowId !== "number") return { error: "没有找到当前 AI 标签页" };
  const wait = Math.max(0, 550 - (Date.now() - lastCaptureAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    lastCaptureAt = Date.now();
    return { dataUrl };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "captureVisibleTab 失败；请确认当前标签页可见" };
  }
}

async function openNativeLibrary(): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(LIBRARY_URL) });
  note("library-opened", "已打开扩展原生收藏库");
  return tab;
}

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] }) as unknown as chrome.runtime.ExtensionContext[];
  if (contexts.length) return;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["DOM_SCRAPING"], justification: "Run the Firebase Google OAuth helper without injecting auth UI into an AI chat page." });
}

async function authenticateWithOffscreen(): Promise<unknown> {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ type: "offscreen-auth-google" });
}
