import type { CaptureDraft, CapturedLink, ClipPatch, ClipRecord, ScreenshotPart, StoredImagePart } from "@answerframe/shared";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { deleteObject, getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { httpsCallable } from "firebase/functions";
import { db, firebaseEnabled, functions, storage } from "./firebase";
import { cloneClip, makeDemoClip } from "./demo";

export interface ClipRepository {
  list(includeDeleted?: boolean): Promise<ClipRecord[]>;
  saveDraft(draft: CaptureDraft, metadata?: Partial<Pick<ClipRecord, "title" | "note" | "tags">>): Promise<ClipRecord>;
  update(id: string, patch: ClipPatch): Promise<ClipRecord>;
  replaceScreenshot(id: string, parts: ScreenshotPart[]): Promise<ClipRecord>;
  recheckLinks(id: string): Promise<ClipRecord>;
  softDelete(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  purge(id: string): Promise<void>;
}

const STORAGE_KEY = "answerframe.clips.v1";
const LOCAL_DB_NAME = "answerframe.local.v1";
const LOCAL_STORE_NAME = "clips";

function readLocal(): ClipRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ClipRecord[];
  } catch {
    return [];
  }
}

let localDbPromise: Promise<IDBDatabase> | undefined;
let localSeedPromise: Promise<void> | undefined;

function openLocalDb(): Promise<IDBDatabase> {
  if (localDbPromise) return localDbPromise;
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("当前浏览器不支持本地 IndexedDB"));
  localDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_STORE_NAME)) db.createObjectStore(LOCAL_STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本地收藏库"));
  });
  return localDbPromise;
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("本地收藏库读写失败"));
  });
}

async function readLocalDb(): Promise<ClipRecord[]> {
  const db = await openLocalDb();
  const transaction = db.transaction(LOCAL_STORE_NAME, "readonly");
  return idbRequest(transaction.objectStore(LOCAL_STORE_NAME).getAll()) as Promise<ClipRecord[]>;
}

async function writeLocalDb(record: ClipRecord): Promise<void> {
  const db = await openLocalDb();
  const transaction = db.transaction(LOCAL_STORE_NAME, "readwrite");
  await idbRequest(transaction.objectStore(LOCAL_STORE_NAME).put(record));
}

async function deleteLocalDb(id: string): Promise<void> {
  const db = await openLocalDb();
  const transaction = db.transaction(LOCAL_STORE_NAME, "readwrite");
  await idbRequest(transaction.objectStore(LOCAL_STORE_NAME).delete(id));
}

async function ensureLocalData(): Promise<void> {
  if (localSeedPromise) return localSeedPromise;
  localSeedPromise = (async () => {
    const records = await readLocalDb();
    if (records.length) return;
    const migrated = readLocal();
    const seed = migrated.length ? migrated : [makeDemoClip()];
    const db = await openLocalDb();
    const transaction = db.transaction(LOCAL_STORE_NAME, "readwrite");
    const store = transaction.objectStore(LOCAL_STORE_NAME);
    for (const record of seed) store.put(record);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("无法初始化本地收藏库"));
      transaction.onabort = () => reject(transaction.error || new Error("本地收藏库初始化被取消"));
    });
  })().catch((error) => {
    localSeedPromise = undefined;
    throw error;
  });
  return localSeedPromise;
}

function isoNow(): string {
  return new Date().toISOString();
}

function titleFromDraft(draft: CaptureDraft): string {
  const firstLine = draft.answerText.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return (firstLine || draft.question || "Saved AI answer").slice(0, 100);
}

function localRecordFromDraft(draft: CaptureDraft, ownerUid: string, metadata: Partial<Pick<ClipRecord, "title" | "note" | "tags">> = {}): ClipRecord {
  const now = isoNow();
  const id = `clip-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  return {
    id,
    ownerUid,
    platform: draft.platform,
    conversationUrl: draft.conversationUrl,
    question: draft.question,
    answerText: draft.answerText,
    theme: draft.theme,
    links: draft.links,
    title: metadata.title?.trim() || titleFromDraft(draft),
    note: metadata.note ?? "",
    tags: metadata.tags ?? [],
    imageParts: draft.screenshotParts.map((part) => ({ pageIndex: part.pageIndex, path: part.dataUrl, width: part.width, height: part.height })),
    thumbnailPath: draft.screenshotParts[0]?.dataUrl || "",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    schemaVersion: 1,
  };
}

class LocalClipRepository implements ClipRepository {
  private ownerUid: string;
  constructor(ownerUid = "demo-user") {
    this.ownerUid = ownerUid;
  }

  async list(includeDeleted = false): Promise<ClipRecord[]> {
    await ensureLocalData();
    return (await readLocalDb()).filter((clip) => clip.ownerUid === this.ownerUid && (includeDeleted || !clip.deletedAt)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async saveDraft(draft: CaptureDraft, metadata = {}): Promise<ClipRecord> {
    await ensureLocalData();
    const record = localRecordFromDraft(draft, this.ownerUid, metadata);
    await writeLocalDb(record);
    return cloneClip(record);
  }

  async update(id: string, patch: ClipPatch): Promise<ClipRecord> {
    await ensureLocalData();
    const records = await readLocalDb();
    const index = records.findIndex((item) => item.id === id && item.ownerUid === this.ownerUid);
    if (index < 0) throw new Error("Clip not found");
    records[index] = { ...records[index], ...patch, updatedAt: isoNow() };
    await writeLocalDb(records[index]);
    return cloneClip(records[index]);
  }

  async replaceScreenshot(id: string, parts: ScreenshotPart[]): Promise<ClipRecord> {
    await ensureLocalData();
    const records = await readLocalDb();
    const index = records.findIndex((item) => item.id === id && item.ownerUid === this.ownerUid);
    if (index < 0) throw new Error("Clip not found");
    records[index] = {
      ...records[index],
      imageParts: parts.map((part) => ({ pageIndex: part.pageIndex, path: part.dataUrl, width: part.width, height: part.height })),
      thumbnailPath: parts[0]?.dataUrl || records[index].thumbnailPath,
      updatedAt: isoNow(),
    };
    await writeLocalDb(records[index]);
    return cloneClip(records[index]);
  }

  async softDelete(id: string): Promise<void> {
    await ensureLocalData();
    const records = await readLocalDb();
    const index = records.findIndex((item) => item.id === id && item.ownerUid === this.ownerUid);
    if (index >= 0) {
      records[index] = { ...records[index], deletedAt: isoNow(), updatedAt: isoNow() };
      await writeLocalDb(records[index]);
    }
  }

  async recheckLinks(id: string): Promise<ClipRecord> {
    await ensureLocalData();
    const records = await readLocalDb();
    const index = records.findIndex((item) => item.id === id && item.ownerUid === this.ownerUid);
    if (index < 0) throw new Error("Clip not found");
    records[index] = { ...records[index], links: records[index].links.map((link) => link.url ? { ...link, status: "checking" } : { ...link, status: "unresolved" }), updatedAt: isoNow() };
    await writeLocalDb(records[index]);
    return cloneClip(records[index]);
  }

  async restore(id: string): Promise<void> {
    await ensureLocalData();
    const records = await readLocalDb();
    const index = records.findIndex((item) => item.id === id && item.ownerUid === this.ownerUid);
    if (index >= 0) {
      records[index] = { ...records[index], deletedAt: null, updatedAt: isoNow() };
      await writeLocalDb(records[index]);
    }
  }

  async purge(id: string): Promise<void> {
    await ensureLocalData();
    const records = await readLocalDb();
    if (records.some((item) => item.id === id && item.ownerUid === this.ownerUid)) await deleteLocalDb(id);
  }
}

function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return fetch(dataUrl).then((response) => response.blob());
}

class FirebaseClipRepository implements ClipRepository {
  constructor(private readonly ownerUid: string) {}

  private clipCollection() {
    if (!db) throw new Error("Firestore is not configured");
    return collection(db, "users", this.ownerUid, "clips");
  }

  async list(includeDeleted = false): Promise<ClipRecord[]> {
    const constraints = includeDeleted ? [orderBy("updatedAt", "desc")] : [where("deletedAt", "==", null), orderBy("updatedAt", "desc")];
    const snapshot = await getDocs(query(this.clipCollection(), ...constraints));
    return snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as ClipRecord));
  }

  async saveDraft(draft: CaptureDraft, metadata = {}): Promise<ClipRecord> {
    if (!db || !storage) throw new Error("Firebase is not configured");
    const clipRef = doc(this.clipCollection());
    const uploaded: string[] = [];
    try {
      const imageParts: StoredImagePart[] = [];
      for (const part of draft.screenshotParts) {
        const path = `users/${this.ownerUid}/clips/${clipRef.id}/page-${part.pageIndex}.webp`;
        const blob = await dataUrlToBlob(part.dataUrl);
        await uploadBytes(ref(storage, path), blob, { contentType: blob.type || "image/webp" });
        uploaded.push(path);
        imageParts.push({ pageIndex: part.pageIndex, path, width: part.width, height: part.height, bytes: blob.size });
      }
      const now = serverTimestamp();
      const record = localRecordFromDraft(draft, this.ownerUid, metadata);
      const cloudRecord = { ...record, id: clipRef.id, imageParts, thumbnailPath: imageParts[0]?.path || "", createdAt: now, updatedAt: now };
      await setDoc(clipRef, cloudRecord);
      return { ...cloudRecord, createdAt: isoNow(), updatedAt: isoNow() } as unknown as ClipRecord;
    } catch (error) {
      await Promise.all(uploaded.map((path) => deleteObject(ref(storage!, path)).catch(() => undefined)));
      throw error;
    }
  }

  async update(id: string, patch: ClipPatch): Promise<ClipRecord> {
    if (!db) throw new Error("Firebase is not configured");
    const clipRef = doc(this.clipCollection(), id);
    await updateDoc(clipRef, { ...patch, updatedAt: serverTimestamp() });
    const snapshot = await getDoc(clipRef);
    if (!snapshot.exists()) throw new Error("Clip not found");
    return { id, ...snapshot.data() } as ClipRecord;
  }

  async replaceScreenshot(id: string, parts: ScreenshotPart[]): Promise<ClipRecord> {
    if (!db || !storage) throw new Error("Firebase is not configured");
    const uploaded: string[] = [];
    try {
      const imageParts: StoredImagePart[] = [];
      for (const part of parts) {
        const path = `users/${this.ownerUid}/clips/${id}/page-${part.pageIndex}-${Date.now()}.webp`;
        const blob = await dataUrlToBlob(part.dataUrl);
        await uploadBytes(ref(storage, path), blob, { contentType: blob.type || "image/webp" });
        uploaded.push(path);
        imageParts.push({ pageIndex: part.pageIndex, path, width: part.width, height: part.height, bytes: blob.size });
      }
      await updateDoc(doc(this.clipCollection(), id), { imageParts, thumbnailPath: imageParts[0]?.path || "", updatedAt: serverTimestamp() });
      const snapshot = await getDoc(doc(this.clipCollection(), id));
      if (!snapshot.exists()) throw new Error("Clip not found");
      return { id, ...snapshot.data() } as ClipRecord;
    } catch (error) {
      await Promise.all(uploaded.map((path) => deleteObject(ref(storage!, path)).catch(() => undefined)));
      throw error;
    }
  }

  async softDelete(id: string): Promise<void> {
    if (!db) throw new Error("Firebase is not configured");
    await updateDoc(doc(this.clipCollection(), id), { deletedAt: serverTimestamp(), updatedAt: serverTimestamp() });
  }
  async recheckLinks(id: string): Promise<ClipRecord> {
    if (!functions || !db) throw new Error("Firebase is not configured");
    const callable = httpsCallable<{ clipId: string }, { links: CapturedLink[] }>(functions, "recheckLinks");
    await callable({ clipId: id });
    const snapshot = await getDoc(doc(this.clipCollection(), id));
    if (!snapshot.exists()) throw new Error("Clip not found");
    return { id, ...snapshot.data() } as ClipRecord;
  }
  async restore(id: string): Promise<void> {
    if (!db) throw new Error("Firebase is not configured");
    await updateDoc(doc(this.clipCollection(), id), { deletedAt: null, updatedAt: serverTimestamp() });
  }
  async purge(id: string): Promise<void> {
    if (!db) throw new Error("Firebase is not configured");
    await deleteDoc(doc(this.clipCollection(), id));
  }
}

export function createRepository(ownerUid?: string): ClipRepository {
  if (firebaseEnabled && ownerUid && db && storage) return new FirebaseClipRepository(ownerUid);
  return new LocalClipRepository(ownerUid || "demo-user");
}

export async function resolveImageUrl(path: string): Promise<string> {
  if (!path) return "";
  if (path.startsWith("data:") || path.startsWith("/") || path.startsWith("http://") || path.startsWith("https://")) return path;
  if (storage) return getDownloadURL(ref(storage, path));
  return path;
}
