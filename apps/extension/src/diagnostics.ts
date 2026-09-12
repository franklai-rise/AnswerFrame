export const DIAGNOSTIC_KEY = "answerframe.diagnostics.v1";

export type DiagnosticStage =
  | "ready"
  | "capture-started"
  | "capture-awaiting-permission"
  | "preview-ready"
  | "draft-stored"
  | "library-opened"
  | "draft-delivered"
  | "save-succeeded"
  | "save-failed";

export interface ExtensionDiagnostic {
  stage: DiagnosticStage;
  message: string;
  at: number;
  transferId?: string;
}

// Keep this intentionally small and content-free. It is visible from the
// extension popup, so it must never contain the captured answer, screenshot,
// question, or source URLs.
export async function recordDiagnostic(
  stage: DiagnosticStage,
  message: string,
  transferId?: string,
): Promise<void> {
  const diagnostic: ExtensionDiagnostic = { stage, message, at: Date.now(), ...(transferId ? { transferId } : {}) };
  await chrome.storage.local.set({ [DIAGNOSTIC_KEY]: diagnostic });
}
