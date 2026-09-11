import { describe, expect, it } from "vitest";
import { makeDemoClip } from "./lib/demo";

describe("AnswerFrame demo data", () => {
  it("contains a screenshot, editable question, and typed sources", () => {
    const clip = makeDemoClip();
    expect(clip.imageParts.length).toBeGreaterThan(0);
    expect(clip.question).toContain("PINN");
    expect(clip.links.some((link) => link.kind === "youtube")).toBe(true);
    expect(clip.links.some((link) => link.kind === "doi")).toBe(true);
  });
});
