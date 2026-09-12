export const DRAFT_TRANSFER_KEY = "answerframe.pending-draft.v1";
export const DRAFT_TRANSFER_CONTEXT_KEY = "answerframe.pending-draft-context.v1";

export interface DraftTransfer {
  id: string;
  draft: unknown;
  createdAt: number;
}

export interface DraftTransferContext {
  id: string;
  sourceTabId?: number;
  createdAt: number;
}

export function createDraftTransfer(draft: unknown): DraftTransfer {
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { id: `draft-${suffix}`, draft, createdAt: Date.now() };
}

export function isDraftTransfer(value: unknown, expectedId?: string): value is DraftTransfer {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DraftTransfer>;
  return typeof candidate.id === "string" && (!expectedId || candidate.id === expectedId) && typeof candidate.createdAt === "number" && "draft" in candidate;
}

export function createDraftTransferContext(transferId: string, sourceTabId?: number): DraftTransferContext {
  return { id: transferId, ...(typeof sourceTabId === "number" ? { sourceTabId } : {}), createdAt: Date.now() };
}

export function isDraftTransferContext(value: unknown, expectedId?: string): value is DraftTransferContext {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DraftTransferContext>;
  return typeof candidate.id === "string"
    && (!expectedId || candidate.id === expectedId)
    && typeof candidate.createdAt === "number"
    && (candidate.sourceTabId === undefined || typeof candidate.sourceTabId === "number");
}
