// Persists the recently-opened-files list as plain JSON in localStorage.
// Only file names (+ timestamp) are stored — a live FileSystemFileHandle
// can't be JSON-serialized, so seamless reopen only works for entries still
// held in memory from the current session; see App.jsx's historyHandlesRef.

const STORAGE_KEY = 'markdown-viewer:recent-files'

export const MAX_HISTORY = 8

export function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    console.error('Failed to load file history:', err)
    return []
  }
}

export function saveHistory(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch (err) {
    console.error('Failed to save file history:', err)
  }
}
