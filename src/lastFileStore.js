// Persists the most recently opened file's live FileSystemFileHandle so the
// app can reopen it after a page refresh or full browser restart.
// A FileSystemFileHandle isn't JSON-serializable, so this can't live in
// localStorage like fileHistory.js's list does — IndexedDB's structured
// clone algorithm is the one browser storage that can hold the handle
// object itself, not just its name.
//
// The handle's read/write permission is not guaranteed to still be granted
// after a restart (browsers may reset it), so loadLastFile() only returns
// the stored record — callers must still check/request permission before
// using the handle, same as fileHistory.js's session-only handles.

const DB_NAME = 'markdown-editor'
const STORE_NAME = 'last-file'
const DB_VERSION = 1
const KEY = 'last'

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveLastFile(handle, name, path) {
  try {
    const db = await openDb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put({ handle, name, path }, KEY)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch (err) {
    console.error('Failed to save last file:', err)
  }
}

export async function loadLastFile() {
  try {
    const db = await openDb()
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(KEY)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
    db.close()
    return result
  } catch (err) {
    console.error('Failed to load last file:', err)
    return null
  }
}

export async function clearLastFile() {
  try {
    const db = await openDb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(KEY)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch (err) {
    console.error('Failed to clear last file:', err)
  }
}
