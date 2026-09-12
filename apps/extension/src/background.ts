import { createDraftTransfer, DRAFT_TRANSFER_KEY, isDraftTransfer } from "./draft-transfer";

const APP_URL = "http://localhost:5173";
let lastCaptureAt = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "capture-visible") {
    void captureVisible(sender.tab?.windowId).then(sendResponse).catch((error) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "open-library-transfer") {
    void openLibraryWithTransfer(String(message.transferId || "")).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  // Keeps already-open AI tabs from older extension code working after the
  // service worker has been reloaded. Fresh content scripts use the durable,
  // storage-backed transfer above so screenshots never need a second large
  // runtime-message hop.
  if (message?.type === "open-library-with-draft") {
    void storeAndOpenLibrary(message.draft).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "auth-google") {
    void authenticateWithOffscreen().then(sendResponse).catch((error) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  return false;
});

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

async function storeAndOpenLibrary(draft: unknown): Promise<void> {
  const transfer = createDraftTransfer(draft);
  await chrome.storage.local.set({ [DRAFT_TRANSFER_KEY]: transfer });
  await openLibraryWithTransfer(transfer.id);
}

async function openLibraryWithTransfer(transferId: string): Promise<void> {
  if (!transferId) throw new Error("保存草稿标识缺失，请重新点击确认");
  const stored = await chrome.storage.local.get(DRAFT_TRANSFER_KEY);
  if (!isDraftTransfer(stored[DRAFT_TRANSFER_KEY], transferId)) throw new Error("保存草稿已过期，请重新点击确认");
  const tab = await chrome.tabs.create({ url: `${APP_URL}/import?from=extension&draftId=${encodeURIComponent(transferId)}` });
  if (typeof tab.id !== "number") throw new Error("无法打开 AnswerFrame 网页");
  await waitForTabLoad(tab.id);
  const delivered = await forwardStoredDraft(tab.id, transferId);
  if (!delivered) throw new Error("AnswerFrame 网页未确认收到草稿，请确认 localhost:5173 正在运行后重试");
}

async function waitForTabLoad(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, 8_000);
    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function forwardStoredDraft(tabId: number, transferId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "answerframe:forward-stored-draft", transferId }) as { ok?: boolean; error?: string } | undefined;
      if (!response?.ok) throw new Error(response?.error || "AnswerFrame 网页尚未确认草稿");
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  return false;
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
