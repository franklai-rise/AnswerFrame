import { describe, expect, it } from "vitest";
import { createDraftTransfer, isDraftTransfer } from "./draft-transfer";

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
});
