import type { CapturedLink, ClipRecord, Platform, Theme } from "@answerframe/shared";

/**
 * The extension page and the service worker intentionally use the same
 * IndexedDB database.  A clip is not visible to the library until its final
 * commit transaction writes the metadata record to `clips`.
 */
export const NATIVE_DB_NAME = "answerframe.local.v1";
export const NATIVE_DB_VERSION = 2;
export const CLIPS_STORE = "clips";
export const IMAGE_PARTS_STORE = "imageParts";
export const UPLOADS_STORE = "uploads";
export const NATIVE_IMAGE_PREFIX = "answerframe-idb://";

const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_PARTS = 80;

export interface NativeUploadMetadata {
  platform: Platform;
  conversationUrl: string;
  question: string;
  answerText: string;
  theme: Theme;
  links: CapturedLink[];
  title: string;
  note: string;
  tags: string[];
  expectedParts: number;
}

export interface NativeUploadPart {
  pageIndex: number;
  dataUrl: string;
  width: number;
  height: number;
}

interface NativeUpload {
  id: string;
  metadata: NativeUploadMetadata;
  sourceTabId?: number;
  createdAt: number;
  updatedAt: number;
}

export interface NativeImagePart {
  id: string;
  clipId: string;
  pageIndex: number;
  blob: Blob;
  width: number;
  height: number;
  createdAt: number;
  uploading: boolean;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("AnswerFrame 本地库读写失败"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("AnswerFrame 本地库事务失败"));
    transaction.onabort = () => reject(transaction.error || new Error("AnswerFrame 本地库事务已取消"));
  });
}

export function nativeImagePath(clipId: string, pageIndex: number): string {
  return `${NATIVE_IMAGE_PREFIX}${clipId}/${pageIndex}`;
}

export function nativeImageId(clipId: string, pageIndex: number): string {
  return `${clipId}:${pageIndex}`;
}

export function openNativeDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(NATIVE_DB_NAME, NATIVE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CLIPS_STORE)) db.createObjectStore(CLIPS_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(IMAGE_PARTS_STORE)) {
        const imageParts = db.createObjectStore(IMAGE_PARTS_STORE, { keyPath: "id" });
        imageParts.createIndex("clipId", "clipId", { unique: false });
      } else {
        const imageParts = request.transaction?.objectStore(IMAGE_PARTS_STORE);
        if (imageParts && !imageParts.indexNames.contains("clipId")) imageParts.createIndex("clipId", "clipId", { unique: false });
      }
      if (!db.objectStoreNames.contains(UPLOADS_STORE)) db.createObjectStore(UPLOADS_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开 AnswerFrame 本地库"));
  });
}

function requireUploadId(value: string): string {
  if (!/^clip-[a-zA-Z0-9_-]{8,160}$/.test(value)) throw new Error("无效的保存标识，请重新确认保存");
  return value;
}

function validateMetadata(value: NativeUploadMetadata): NativeUploadMetadata {
  if (!value || (value.platform !== "chatgpt" && value.platform !== "gemini")) throw new Error("不支持的回答来源");
  if (!Number.isInteger(value.expectedParts) || value.expectedParts < 1 || value.expectedParts > MAX_PARTS) throw new Error("截图页数无效");
  if (!Array.isArray(value.links) || !Array.isArray(value.tags)) throw new Error("收藏元数据无效");
  if (typeof value.conversationUrl !== "string" || typeof value.question !== "string" || typeof value.answerText !== "string") throw new Error("回答内容无效");
  if (value.theme !== "light" && value.theme !== "dark") throw new Error("截图主题无效");
  return {
    ...value,
    title: String(value.title || "Saved AI answer").trim().slice(0, 160) || "Saved AI answer",
    note: String(value.note || "").slice(0, 20_000),
    tags: value.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 40),
  };
}

function validatePart(part: NativeUploadPart): NativeUploadPart {
  if (!part || !Number.isInteger(part.pageIndex) || part.pageIndex < 0 || part.pageIndex >= MAX_PARTS) throw new Error("截图页索引无效");
  if (typeof part.dataUrl !== "string" || !part.dataUrl.startsWith("data:image/")) throw new Error("截图格式无效");
  if (!Number.isFinite(part.width) || !Number.isFinite(part.height) || part.width < 1 || part.height < 1) throw new Error("截图尺寸无效");
  return part;
}

async function dataUrlToImageBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/") || blob.size === 0 || blob.size > MAX_PART_BYTES) throw new Error("单张截图必须是小于 8 MiB 的图片");
  return blob;
}

export async function beginNativeUpload(id: string, metadata: NativeUploadMetadata, sourceTabId?: number): Promise<void> {
  const uploadId = requireUploadId(id);
  const validated = validateMetadata(metadata);
  const db = await openNativeDb();
  const now = Date.now();
  const existing = await requestResult(db.transaction(UPLOADS_STORE, "readonly").objectStore(UPLOADS_STORE).get(uploadId)) as NativeUpload | undefined;
  if (existing) throw new Error("同一条回答正在保存，请等待完成");
  const transaction = db.transaction(UPLOADS_STORE, "readwrite");
  transaction.objectStore(UPLOADS_STORE).put({ id: uploadId, metadata: validated, ...(typeof sourceTabId === "number" ? { sourceTabId } : {}), createdAt: now, updatedAt: now } satisfies NativeUpload);
  await transactionComplete(transaction);
}

export async function writeNativeUploadPart(id: string, part: NativeUploadPart): Promise<void> {
  const uploadId = requireUploadId(id);
  const validated = validatePart(part);
  const blob = await dataUrlToImageBlob(validated.dataUrl);
  const db = await openNativeDb();
  const upload = await requestResult(db.transaction(UPLOADS_STORE, "readonly").objectStore(UPLOADS_STORE).get(uploadId)) as NativeUpload | undefined;
  if (!upload) throw new Error("保存会话已过期，请重新确认保存");
  if (validated.pageIndex >= upload.metadata.expectedParts) throw new Error("截图页索引超出范围");
  const transaction = db.transaction([UPLOADS_STORE, IMAGE_PARTS_STORE], "readwrite");
  transaction.objectStore(IMAGE_PARTS_STORE).put({
    id: nativeImageId(uploadId, validated.pageIndex),
    clipId: uploadId,
    pageIndex: validated.pageIndex,
    blob,
    width: Math.round(validated.width),
    height: Math.round(validated.height),
    createdAt: Date.now(),
    uploading: true,
  } satisfies NativeImagePart);
  transaction.objectStore(UPLOADS_STORE).put({ ...upload, updatedAt: Date.now() } satisfies NativeUpload);
  await transactionComplete(transaction);
}

async function getNativeUpload(db: IDBDatabase, id: string): Promise<NativeUpload | undefined> {
  return requestResult(db.transaction(UPLOADS_STORE, "readonly").objectStore(UPLOADS_STORE).get(id)) as Promise<NativeUpload | undefined>;
}

async function getImagesForClip(db: IDBDatabase, clipId: string): Promise<NativeImagePart[]> {
  const transaction = db.transaction(IMAGE_PARTS_STORE, "readonly");
  const store = transaction.objectStore(IMAGE_PARTS_STORE);
  if (store.indexNames.contains("clipId")) return requestResult(store.index("clipId").getAll(clipId)) as Promise<NativeImagePart[]>;
  const all = await requestResult(store.getAll()) as NativeImagePart[];
  return all.filter((item) => item.clipId === clipId);
}

function recordFromUpload(upload: NativeUpload, images: NativeImagePart[]): ClipRecord {
  const ordered = [...images].sort((a, b) => a.pageIndex - b.pageIndex);
  const now = new Date().toISOString();
  return {
    id: upload.id,
    ownerUid: "native-user",
    platform: upload.metadata.platform,
    conversationUrl: upload.metadata.conversationUrl,
    question: upload.metadata.question,
    answerText: upload.metadata.answerText,
    theme: upload.metadata.theme,
    links: upload.metadata.links,
    title: upload.metadata.title,
    note: upload.metadata.note,
    tags: upload.metadata.tags,
    imageParts: ordered.map((image) => ({ pageIndex: image.pageIndex, path: nativeImagePath(upload.id, image.pageIndex), width: image.width, height: image.height, bytes: image.blob.size })),
    thumbnailPath: ordered[0] ? nativeImagePath(upload.id, ordered[0].pageIndex) : "",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    schemaVersion: 1,
  };
}

export async function commitNativeUpload(id: string): Promise<{ clip: ClipRecord; sourceTabId?: number }> {
  const uploadId = requireUploadId(id);
  const db = await openNativeDb();
  const upload = await getNativeUpload(db, uploadId);
  if (!upload) throw new Error("保存会话已过期，请重新确认保存");
  const images = await getImagesForClip(db, uploadId);
  const expected = new Set(Array.from({ length: upload.metadata.expectedParts }, (_, index) => index));
  for (const image of images) expected.delete(image.pageIndex);
  if (expected.size) throw new Error("截图上传未完成，请重新确认保存");
  const clip = recordFromUpload(upload, images);
  const transaction = db.transaction([CLIPS_STORE, IMAGE_PARTS_STORE, UPLOADS_STORE], "readwrite");
  transaction.objectStore(CLIPS_STORE).put(clip);
  const imageStore = transaction.objectStore(IMAGE_PARTS_STORE);
  for (const image of images) imageStore.put({ ...image, uploading: false } satisfies NativeImagePart);
  transaction.objectStore(UPLOADS_STORE).delete(uploadId);
  await transactionComplete(transaction);
  return { clip, sourceTabId: upload.sourceTabId };
}

export async function abortNativeUpload(id: string): Promise<void> {
  const uploadId = requireUploadId(id);
  const db = await openNativeDb();
  const images = await getImagesForClip(db, uploadId);
  const transaction = db.transaction([UPLOADS_STORE, IMAGE_PARTS_STORE], "readwrite");
  transaction.objectStore(UPLOADS_STORE).delete(uploadId);
  const store = transaction.objectStore(IMAGE_PARTS_STORE);
  for (const image of images) {
    if (image.uploading) store.delete(image.id);
  }
  await transactionComplete(transaction);
}

/** Deletes incomplete image chunks left behind after a browser/service-worker interruption. */
export async function cleanupStaleNativeUploads(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
  const db = await openNativeDb();
  const uploads = await requestResult(db.transaction(UPLOADS_STORE, "readonly").objectStore(UPLOADS_STORE).getAll()) as NativeUpload[];
  const staleIds = new Set(uploads.filter((upload) => upload.updatedAt < Date.now() - maxAgeMs).map((upload) => upload.id));
  if (!staleIds.size) return;
  const images = await requestResult(db.transaction(IMAGE_PARTS_STORE, "readonly").objectStore(IMAGE_PARTS_STORE).getAll()) as NativeImagePart[];
  const transaction = db.transaction([UPLOADS_STORE, IMAGE_PARTS_STORE], "readwrite");
  const uploadStore = transaction.objectStore(UPLOADS_STORE);
  const imageStore = transaction.objectStore(IMAGE_PARTS_STORE);
  staleIds.forEach((id) => uploadStore.delete(id));
  images.filter((image) => image.uploading && staleIds.has(image.clipId)).forEach((image) => imageStore.delete(image.id));
  await transactionComplete(transaction);
}
