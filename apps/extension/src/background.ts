const APP_URL = "http://localhost:5173";
let lastCaptureAt = 0;
const pendingForward = new Map<number, unknown>();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "capture-visible") {
    void captureVisible(sender.tab?.windowId).then(sendResponse).catch((error) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "open-library-with-draft") {
    void openLibraryWithDraft(message.draft).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
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

async function openLibraryWithDraft(draft: unknown): Promise<void> {
  const tab = await chrome.tabs.create({ url: `${APP_URL}/import?from=extension` });
  if (typeof tab.id !== "number") throw new Error("无法打开 AnswerFrame 网页");
  pendingForward.set(tab.id, draft);
  const delivered = await forwardDraft(tab.id);
  if (!delivered) throw new Error("AnswerFrame 网页未确认收到草稿，请确认 localhost:5173 正在运行后重试");
}

async function forwardDraft(tabId: number): Promise<boolean> {
  const value = pendingForward.get(tabId);
  if (value === undefined) return false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "answerframe:forward-draft", draft: value }) as { ok?: boolean; error?: string } | undefined;
      if (!response?.ok) throw new Error(response?.error || "AnswerFrame 网页尚未确认草稿");
      pendingForward.delete(tabId);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  pendingForward.delete(tabId);
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
