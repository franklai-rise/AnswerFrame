import { promises as dns } from "node:dns";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { initializeApp } from "firebase-admin/app";
import { logger } from "firebase-functions";
import { setGlobalOptions } from "firebase-functions/v2";
import { onDocumentCreated, onDocumentDeleted, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { isPublicHttpUrl, mapHttpStatus, type CapturedLink, type LinkStatus } from "@answerframe/shared";

initializeApp();
setGlobalOptions({ region: "asia-east1", maxInstances: 5, timeoutSeconds: 60 });

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

interface CheckResult {
  status: LinkStatus;
  statusCode?: number;
  finalUrl?: string;
  checkedAt: string;
}

function privateIp(ip: string): boolean {
  const value = ip.toLowerCase();
  if (value.includes(":")) return value === "::1" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd");
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item))) return false;
  const [a, b] = octets;
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function safePublicHost(url: string): Promise<boolean> {
  if (!isPublicHttpUrl(url)) return false;
  const hostname = new URL(url).hostname;
  try {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every((address) => !privateIp(address.address));
  } catch {
    return false;
  }
}

async function checkUrl(value: string): Promise<CheckResult> {
  const checkedAt = new Date().toISOString();
  if (!value) return { status: "unresolved", checkedAt };
  let current = value;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    if (!(await safePublicHost(current))) return { status: "unknown", checkedAt };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(current, {
        method: "HEAD",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "AnswerFrame-Link-Validator/0.1" },
      });
      clearTimeout(timeout);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirect === MAX_REDIRECTS) return { status: "unknown", statusCode: response.status, finalUrl: current, checkedAt };
        current = new URL(location, current).toString();
        continue;
      }
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_RESPONSE_BYTES) return { status: mapHttpStatus(response.status, current !== value), statusCode: response.status, finalUrl: current, checkedAt };
      return { status: mapHttpStatus(response.status, current !== value), statusCode: response.status, finalUrl: current, checkedAt };
    } catch (error) {
      clearTimeout(timeout);
      logger.debug("Link check failed", { value, error: String(error) });
      return { status: "unknown", checkedAt };
    }
  }
  return { status: "unknown", checkedAt };
}

async function checkLinks(links: CapturedLink[]): Promise<CapturedLink[]> {
  const results: CapturedLink[] = [];
  for (const link of links) {
    const checked = await checkUrl(link.url);
    results.push({ ...link, ...checked });
  }
  return results;
}

export const validateLinksAfterCreate = onDocumentCreated("users/{userId}/clips/{clipId}", async (event) => {
  const snapshot = event.data;
  if (!snapshot) return;
  const data = snapshot.data() as { links?: CapturedLink[] };
  if (!Array.isArray(data.links) || data.links.length === 0) return;
  const links = data.links.map((link) => ({ ...link, status: link.url ? "checking" : "unresolved" as LinkStatus }));
  await snapshot.ref.update({ links, updatedAt: FieldValue.serverTimestamp() });
  const checked = await checkLinks(links);
  await snapshot.ref.update({ links: checked, updatedAt: FieldValue.serverTimestamp() });
});

export const validateChangedLinks = onDocumentUpdated("users/{userId}/clips/{clipId}", async (event) => {
  const before = event.data?.before.data() as { links?: CapturedLink[] } | undefined;
  const afterSnapshot = event.data?.after;
  if (!afterSnapshot) return;
  const beforeLinks = Array.isArray(before?.links) ? before.links : [];
  const afterData = afterSnapshot.data() as { links?: CapturedLink[] };
  const afterLinks = Array.isArray(afterData.links) ? afterData.links : [];
  const beforeById = new Map(beforeLinks.map((link) => [link.id, link]));
  const changedIds = new Set(afterLinks.filter((link) => beforeById.get(link.id)?.url !== link.url).map((link) => link.id));
  if (changedIds.size === 0) return;
  const pending = afterLinks.map((link) => changedIds.has(link.id) ? { ...link, status: link.url ? "checking" : "unresolved" as LinkStatus } : link);
  await afterSnapshot.ref.update({ links: pending, updatedAt: FieldValue.serverTimestamp() });
  const checked = await Promise.all(pending.map(async (link) => changedIds.has(link.id) ? { ...link, ...(await checkUrl(link.url)) } : link));
  await afterSnapshot.ref.update({ links: checked, updatedAt: FieldValue.serverTimestamp() });
});

export const recheckLinks = onCall(async (request) => {
  if (!request.auth || request.auth.token.answerframeOwner !== true) throw new HttpsError("permission-denied", "AnswerFrame owner claim required");
  const clipId = typeof request.data?.clipId === "string" ? request.data.clipId : "";
  if (!clipId || !/^[A-Za-z0-9_-]{1,128}$/.test(clipId)) throw new HttpsError("invalid-argument", "clipId is required");
  const ref = getFirestore().doc(`users/${request.auth.uid}/clips/${clipId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpsError("not-found", "Clip not found");
  const data = snapshot.data() as { links?: CapturedLink[] };
  const links = Array.isArray(data.links) ? data.links : [];
  await ref.update({ links: links.map((link) => ({ ...link, status: link.url ? "checking" : "unresolved" })), updatedAt: FieldValue.serverTimestamp() });
  const checked = await checkLinks(links);
  await ref.update({ links: checked, updatedAt: FieldValue.serverTimestamp() });
  return { links: checked };
});

export const deleteClipImages = onDocumentDeleted("users/{userId}/clips/{clipId}", async (event) => {
  const bucket = getStorage().bucket();
  await bucket.deleteFiles({ prefix: `users/${event.params.userId}/clips/${event.params.clipId}/` }).catch((error) => logger.warn("Image cleanup failed", { error: String(error) }));
});

export const purgeExpiredClips = onSchedule("every 24 hours", async () => {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const snapshots = await getFirestore().collectionGroup("clips").where("deletedAt", "<", cutoff).limit(100).get();
  if (snapshots.empty) return;
  const batch = getFirestore().batch();
  snapshots.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
});
