import { describe, expect, it } from "vitest";
import { needsActiveTabGrant } from "./capture-permission";

describe("capture permission diagnosis", () => {
  it("recognizes Chrome's captureVisibleTab activeTab error", () => {
    expect(needsActiveTabGrant("Either the '<all_urls>' or 'activeTab' permission is required.")).toBe(true);
  });

  it("does not mislabel an ordinary capture error", () => {
    expect(needsActiveTabGrant("The tab is not currently visible")).toBe(false);
  });
});
