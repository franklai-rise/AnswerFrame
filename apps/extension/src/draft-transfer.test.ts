import { describe, expect, it } from "vitest";
import {
  createDraftTransfer,
  createDraftTransferContext,
  isDraftTransfer,
  isDraftTransferContext,
} from "./draft-transfer";

describe("draft transfer", () => {
  it("creates a self-identifying storage payload", () => {
    const transfer = createDraftTransfer({ answerText: "test" });
    expect(transfer.id).toMatch(/^draft-/);
    expect(transfer.createdAt).toBeTypeOf("number");
    expect(isDraftTransfer(transfer)).toBe(true);
    expect(isDraftTransfer(transfer, transfer.id)).toBe(true);
  });

  it("rejects an expired or malformed payload", () => {
    const transfer = createDraftTransfer({ answerText: "test" });
    expect(isDraftTransfer(transfer, "draft-other")).toBe(false);
    expect(isDraftTransfer({ id: "draft-test", createdAt: "now", draft: {} })).toBe(false);
    expect(isDraftTransfer(null)).toBe(false);
  });

  it("keeps only small routing metadata after the page receives the draft", () => {
    const context = createDraftTransferContext("draft-test", 123);
    expect(context).toEqual(expect.objectContaining({ id: "draft-test", sourceTabId: 123 }));
    expect(isDraftTransferContext(context, "draft-test")).toBe(true);
    expect(isDraftTransferContext({ id: "draft-test", createdAt: Date.now(), sourceTabId: "123" })).toBe(false);
  });
});
