import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  CLIPS_STORE,
  IMAGE_PARTS_STORE,
  beginNativeUpload,
  commitNativeUpload,
  nativeImageId,
  nativeImagePath,
  openNativeDb,
  writeNativeUploadPart,
} from "./native-store";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe("native extension store", () => {
  it("keeps image chunks invisible until the final metadata commit", async () => {
    const uploadId = "clip-native-store-test-0001";
    await beginNativeUpload(uploadId, {
      platform: "chatgpt",
      conversationUrl: "https://chatgpt.com/c/example",
      question: "What is a PINN?",
      answerText: "A physics-informed neural network.",
      theme: "light",
      links: [],
      title: "PINN notes",
      note: "Read again later",
      tags: ["PINNs"],
      expectedParts: 2,
    }, 42);
    await writeNativeUploadPart(uploadId, { pageIndex: 0, dataUrl: "data:image/webp;base64,AA==", width: 1200, height: 800 });
    await writeNativeUploadPart(uploadId, { pageIndex: 1, dataUrl: "data:image/webp;base64,AQ==", width: 1200, height: 700 });

    const beforeCommitDb = await openNativeDb();
    const beforeCommit = await requestResult(beforeCommitDb.transaction(CLIPS_STORE, "readonly").objectStore(CLIPS_STORE).get(uploadId));
    expect(beforeCommit).toBeUndefined();

    const { clip, sourceTabId } = await commitNativeUpload(uploadId);
    expect(sourceTabId).toBe(42);
    expect(clip.thumbnailPath).toBe(nativeImagePath(uploadId, 0));
    expect(clip.imageParts).toHaveLength(2);

    const db = await openNativeDb();
    const transaction = db.transaction([CLIPS_STORE, IMAGE_PARTS_STORE], "readonly");
    const storedClip = await requestResult(transaction.objectStore(CLIPS_STORE).get(uploadId));
    const storedImage = await requestResult(transaction.objectStore(IMAGE_PARTS_STORE).get(nativeImageId(uploadId, 0))) as { uploading?: boolean; blob?: Blob } | undefined;
    expect(storedClip).toMatchObject({ id: uploadId, ownerUid: "native-user" });
    expect(storedImage?.uploading).toBe(false);
    expect(storedImage?.blob?.size).toBe(1);
  });
});
