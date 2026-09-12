/** Chrome returns this when a content-script click has not yet been backed by
 * a user invocation of the extension action. */
export function needsActiveTabGrant(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /(?:(?:<all_urls>|all_urls).*activeTab.*permission.*required|activeTab.*permission.*required)/i.test(message);
}
