import { DIAGNOSTIC_KEY, type ExtensionDiagnostic } from "./diagnostics";

const NATIVE_LIBRARY_URL = chrome.runtime.getURL("library.html");

document.getElementById("open-library")?.addEventListener("click", () => {
  void chrome.tabs.create({ url: NATIVE_LIBRARY_URL });
  window.close();
});

document.getElementById("open-options")?.addEventListener("click", () => {
  void chrome.tabs.create({ url: `${NATIVE_LIBRARY_URL}#/settings` });
  window.close();
});

function renderDiagnostic(diagnostic?: ExtensionDiagnostic): void {
  const status = document.getElementById("diagnostic-status");
  const time = document.getElementById("diagnostic-time");
  if (!status || !time) return;
  if (!diagnostic) {
    status.textContent = "尚未执行保存";
    time.textContent = "点击回答下方的 Save to AnswerFrame 开始";
    return;
  }
  status.textContent = diagnostic.message;
  time.textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(diagnostic.at));
}

async function refreshDiagnostic(): Promise<void> {
  const stored = await chrome.storage.local.get(DIAGNOSTIC_KEY);
  renderDiagnostic(stored[DIAGNOSTIC_KEY] as ExtensionDiagnostic | undefined);
}

document.getElementById("refresh-status")?.addEventListener("click", () => void refreshDiagnostic());
void refreshDiagnostic();
