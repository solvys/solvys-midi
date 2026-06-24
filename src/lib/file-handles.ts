const DB_NAME = "solvys-midi";
const STORE_NAME = "handles";
const DB_VERSION = 1;

export type DirectoryKey = "exportDirectory" | "importDirectory";

function openHandleDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function supportsDirectoryPicker() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function" && typeof indexedDB !== "undefined";
}

export async function saveDirectoryHandle(key: DirectoryKey, handle: FileSystemDirectoryHandle) {
  const db = await openHandleDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getDirectoryHandle(key: DirectoryKey) {
  if (!supportsDirectoryPicker()) {
    return null;
  }

  const db = await openHandleDb();
  const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();

  return handle;
}

export async function pickDirectory(key: DirectoryKey) {
  if (!window.showDirectoryPicker) {
    return null;
  }

  const handle = await window.showDirectoryPicker({ mode: key === "exportDirectory" ? "readwrite" : "read" });
  await saveDirectoryHandle(key, handle);
  return handle;
}

export async function ensureWritePermission(handle: FileSystemDirectoryHandle) {
  const current = await handle.queryPermission({ mode: "readwrite" });
  if (current === "granted") {
    return true;
  }

  return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
}

export async function writeMidiFile(handle: FileSystemDirectoryHandle, filename: string, blob: Blob) {
  const permitted = await ensureWritePermission(handle);
  if (!permitted) {
    throw new Error("Export folder permission was denied.");
  }

  const file = await handle.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(blob);
  await writable.close();
}

export async function shareMidiFile(blob: Blob, filename: string, title: string) {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
    return false;
  }

  const userAgent = navigator.userAgent || "";
  const isTouchMac = userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1;
  const isMobileLike = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) || isTouchMac;
  if (!isMobileLike) {
    return false;
  }

  const file = new File([blob], filename, { type: blob.type || "audio/midi" });
  const canShareFiles = typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });

  if (!canShareFiles) {
    return false;
  }

  await navigator.share({
    files: [file],
    title,
    text: "Save file",
  });

  return true;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}
