import { useState, useRef, useEffect, useCallback } from 'react'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import rehypeStringify from 'rehype-stringify'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { findAndReplace } from 'mdast-util-find-and-replace'
import 'highlight.js/styles/github.css'
import { loadHistory, saveHistory, MAX_HISTORY } from './fileHistory'
import { saveLastFile, loadLastFile, clearLastFile } from './lastFileStore'
import './App.css'

// `==text==` isn't part of GFM, so there's no remark-gfm support for it.
// Turn matches into raw inline HTML (mdast 'html' nodes); rehype-raw (used
// in the unified pipeline below) then parses that into real <mark> elements.
function remarkHighlightMark() {
  return (tree) => {
    findAndReplace(tree, [
      [/==([^=\n]+)==/g, (_, text) => [
        { type: 'html', value: '<mark>' },
        { type: 'text', value: text },
        { type: 'html', value: '</mark>' },
      ]],
    ])
  }
}

function rehypeAddLineNumbers() {
  return (tree) => {
    function walk(node) {
      if (node.type === 'element' && node.position) {
        if (!node.properties) node.properties = {}
        node.properties['data-line'] = node.position.start.line
        node.properties['data-line-end'] = node.position.end.line
      }
      if (node.children) node.children.forEach(walk)
    }
    walk(tree)
  }
}

// Wraps each line inside rendered <pre><code> blocks with a span so individual
// lines can be targeted for the secondary highlight.
function rehypeWrapCodeLines() {
  return (tree) => {
    function processCode(code) {
      const lines = [[]]

      for (const child of code.children) {
        if (child.type === 'text') {
          child.value.split('\n').forEach((part, i) => {
            if (i > 0) lines.push([])
            if (part) lines[lines.length - 1].push({ type: 'text', value: part })
          })
        } else if (child.type === 'element') {
          // If a highlighted span contains a newline, split it across lines.
          const innerText = child.children.filter(c => c.type === 'text').map(c => c.value).join('')
          if (innerText.includes('\n')) {
            innerText.split('\n').forEach((part, i) => {
              if (i > 0) lines.push([])
              lines[lines.length - 1].push({ ...child, children: [{ type: 'text', value: part }] })
            })
          } else {
            lines[lines.length - 1].push(child)
          }
        }
      }

      // Trim trailing empty line produced by the final \n in the source.
      while (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop()

      code.children = lines.map((lineChildren, i) => ({
        type: 'element',
        tagName: 'span',
        properties: { className: ['code-line'], 'data-code-line': String(i + 1) },
        children: lineChildren.length ? lineChildren : [{ type: 'text', value: '​' }],
      }))
    }

    function walk(node) {
      if (node.tagName === 'pre') {
        const code = node.children?.find(c => c.type === 'element' && c.tagName === 'code')
        if (code) processCode(code)
      }
      if (node.children) node.children.forEach(walk)
    }
    walk(tree)
  }
}

// Returns { sourceLine, lineWithinBlock } (both 1-indexed) when cursorLine is
// inside a fenced code block, otherwise null.
function getCodeBlockInfo(text, cursorLine) {
  const lines = text.split('\n')
  const BACKTICK = /^`{3,}/
  const TILDE    = /^~{3,}/
  let inBlock = false
  let blockStart = -1
  let closingRe = null

  for (let i = 0; i < cursorLine - 1; i++) {
    const line = lines[i] || ''
    if (!inBlock) {
      if (BACKTICK.test(line))      { inBlock = true; blockStart = i; closingRe = /^`{3,}\s*$/ }
      else if (TILDE.test(line))    { inBlock = true; blockStart = i; closingRe = /^~{3,}\s*$/ }
    } else if (closingRe.test(line.trim())) {
      inBlock = false; blockStart = -1; closingRe = null
    }
  }

  if (!inBlock || blockStart < 0) return null
  return {
    sourceLine: blockStart + 1,                   // 1-indexed line of the opening fence
    lineWithinBlock: cursorLine - blockStart - 1, // 1-indexed content line
  }
}

// Manual unified pipeline (replaces react-markdown) so the rendered HTML can
// be produced as a plain string and poured into a contentEditable element we
// own imperatively — react-markdown owns its output as React-managed vdom,
// which can't coexist with letting the browser mutate that DOM directly as
// the user types.
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkHighlightMark)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeHighlight)
  .use(rehypeAddLineNumbers)
  .use(rehypeWrapCodeLines)
  .use(rehypeStringify, { allowDangerousHtml: true })

function renderMarkdownToHtml(markdown) {
  return processor.processSync(markdown).toString()
}

// Converts the edited preview HTML back into markdown source. Runs on the
// whole document each time (not a diff), so it can normalise unrelated
// formatting conventions (heading style, bullet/emphasis characters) even in
// parts of the file the user didn't touch — options below match this app's
// existing markdown style to minimise that.
const turndownService = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
})
turndownService.use(gfm)
turndownService.addRule('mark', {
  filter: 'mark',
  replacement: (content) => `==${content}==`,
})

// <pre> blocks are frozen (contentEditable="false") after every render, so
// code editing stays exclusive to the raw source textarea.
function freezeCodeBlocks(article) {
  article.querySelectorAll('pre').forEach(pre => { pre.contentEditable = 'false' })
}

export default function App() {
  const [content, setContent] = useState(null)
  const [fileName, setFileName] = useState(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [saveStatus, setSaveStatus] = useState(null)
  const [history, setHistory] = useState([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [rootDirName, setRootDirName] = useState(null)
  // A last-opened file found in IndexedDB at mount that couldn't be
  // silently reopened (permission not currently granted) — rendered as a
  // one-click prompt, since browsers require a user gesture to (re)request
  // File System Access permission.
  const [pendingReopen, setPendingReopen] = useState(null)
  const inputRef = useRef(null)
  const editorRef = useRef(null)
  const previewRef = useRef(null)
  const articleRef = useRef(null)
  // Set right before a preview-originated edit calls setContent(), so the
  // innerHTML-sync effect below skips re-rendering (which would blow away
  // the caret) for the one render that change causes.
  const suppressNextSyncRef = useRef(false)
  const previewSyncTimerRef = useRef(null)
  const activeBlockRef = useRef(null)
  const activeCodeLineRef = useRef(null)
  const fileHandleRef = useRef(null)
  const saveTimerRef = useRef(null)
  const savedFadeTimerRef = useRef(null)
  const historyMenuRef = useRef(null)
  // Live handles only survive for the current session (JSON in localStorage
  // can't hold a FileSystemFileHandle) — keyed by name, separate from the
  // persisted `history` list.
  const historyHandlesRef = useRef(new Map())
  // Root folder chosen for computing relative paths in the history list —
  // session-only: FileSystemDirectoryHandle can't be JSON-serialized into
  // localStorage, same reason file handles above are memory-only.
  const rootDirHandleRef = useRef(null)
  const supportsFsAccess = 'showOpenFilePicker' in window
  const supportsDirPicker = 'showDirectoryPicker' in window

  useEffect(() => {
    setHistory(loadHistory())
  }, [])

  // On mount, try to reopen whatever file was open last (tracked in
  // IndexedDB, since it holds a live FileSystemFileHandle localStorage
  // can't store). If read/write permission is still granted from before —
  // common on a plain page refresh — it reopens with no interaction at all.
  // Otherwise it's surfaced as a one-click prompt: browsers require a user
  // gesture to (re)grant File System Access permission, so a silent
  // reopen isn't possible after e.g. a full browser restart.
  useEffect(() => {
    (async () => {
      const last = await loadLastFile()
      if (!last?.handle) return
      try {
        const perm = await last.handle.queryPermission({ mode: 'readwrite' })
        if (perm === 'granted') {
          const file = await last.handle.getFile()
          fileHandleRef.current = last.handle
          setFileName(file.name)
          setContent(await file.text())
          setSaveStatus(null)
          addToHistory(file.name, last.handle, (await computeRelativePath(last.handle)) || last.path)
        } else {
          setPendingReopen(last)
        }
      } catch (err) {
        console.error('Failed to auto-reopen last file:', err)
      }
    })()
  }, [])

  // Click handler for the one-click "Reopen <name>?" prompt — the user
  // gesture browsers require before (re)granting File System Access
  // permission for a handle restored from IndexedDB.
  async function confirmReopenLast() {
    const last = pendingReopen
    if (!last) return
    try {
      const perm = await last.handle.requestPermission({ mode: 'readwrite' })
      if (perm === 'granted') {
        const file = await last.handle.getFile()
        fileHandleRef.current = last.handle
        setFileName(file.name)
        setContent(await file.text())
        setSaveStatus(null)
        addToHistory(file.name, last.handle, (await computeRelativePath(last.handle)) || last.path)
      }
    } catch (err) {
      console.error('Failed to reopen last file:', err)
    }
    setPendingReopen(null)
  }

  function dismissReopenLast() {
    setPendingReopen(null)
    clearLastFile()
  }

  // Resolves a file handle to a path relative to the chosen root folder —
  // the only thing a browser will let a page compute, since it never
  // exposes real absolute filesystem paths. Null if no root is set or the
  // file isn't inside it (falls back to the bare name in that case).
  async function computeRelativePath(handle) {
    const root = rootDirHandleRef.current
    if (!root) return null
    try {
      const segments = await root.resolve(handle)
      return segments ? segments.join('/') : null
    } catch {
      return null
    }
  }

  async function chooseRootFolder() {
    try {
      const handle = await window.showDirectoryPicker()
      rootDirHandleRef.current = handle
      setRootDirName(handle.name)
    } catch (err) {
      if (err.name !== 'AbortError') console.error(err)
    }
  }

  function clearRootFolder() {
    rootDirHandleRef.current = null
    setRootDirName(null)
  }

  useEffect(() => {
    if (!historyOpen) return
    function handleOutsideClick(e) {
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target)) {
        setHistoryOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [historyOpen])

  // `path` (relative to the chosen root, falling back to the bare name) is
  // the dedupe key and display string — two same-named files in different
  // folders stay as distinct entries instead of colliding.
  function addToHistory(name, handle, relPath) {
    const path = relPath || name
    if (handle) historyHandlesRef.current.set(path, handle)
    setHistory(prev => {
      const next = [{ name, path, openedAt: Date.now() }, ...prev.filter(e => e.path !== path)].slice(0, MAX_HISTORY)
      saveHistory(next)
      return next
    })
  }

  function removeFromHistory(path, e) {
    e.stopPropagation()
    historyHandlesRef.current.delete(path)
    setHistory(prev => {
      const next = prev.filter(entry => entry.path !== path)
      saveHistory(next)
      return next
    })
  }

  async function openFile() {
    setHistoryOpen(false)
    if (supportsFsAccess) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.txt'] } }],
        })
        const file = await handle.getFile()
        const relPath = await computeRelativePath(handle)
        fileHandleRef.current = handle
        setFileName(file.name)
        setContent(await file.text())
        setSaveStatus(null)
        addToHistory(file.name, handle, relPath)
        saveLastFile(handle, file.name, relPath)
      } catch (err) {
        if (err.name !== 'AbortError') console.error(err)
      }
    } else {
      inputRef.current.click()
    }
  }

  // Tap a history row: reopen instantly if we still hold a live handle from
  // this session, otherwise fall back to the file picker (browsers don't
  // allow silently re-reading a file across reloads from a name/path alone).
  async function reopenFromHistory(entry) {
    setHistoryOpen(false)
    const handle = historyHandlesRef.current.get(entry.path)
    if (handle) {
      try {
        let perm = await handle.queryPermission({ mode: 'readwrite' })
        if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' })
        if (perm === 'granted') {
          const file = await handle.getFile()
          const relPath = (await computeRelativePath(handle)) || entry.path
          fileHandleRef.current = handle
          setFileName(file.name)
          setContent(await file.text())
          setSaveStatus(null)
          addToHistory(file.name, handle, relPath)
          saveLastFile(handle, file.name, relPath)
          return
        }
      } catch (err) {
        console.error('Failed to reopen file from history:', err)
        historyHandlesRef.current.delete(entry.path)
      }
    }
    openFile()
  }

  function handleFileInput(e) {
    const file = e.target.files[0]
    if (!file) return
    fileHandleRef.current = null
    setFileName(file.name)
    setSaveStatus(null)
    const reader = new FileReader()
    reader.onload = (ev) => setContent(ev.target.result)
    reader.readAsText(file)
    addToHistory(file.name, null, null)
  }

  function scheduleAutosave(text) {
    if (!fileHandleRef.current) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    if (savedFadeTimerRef.current) clearTimeout(savedFadeTimerRef.current)
    setSaveStatus('saving')
    saveTimerRef.current = setTimeout(async () => {
      try {
        const writable = await fileHandleRef.current.createWritable()
        await writable.write(text)
        await writable.close()
        setSaveStatus('saved')
        savedFadeTimerRef.current = setTimeout(() => setSaveStatus(null), 1500)
      } catch (err) {
        console.error('Autosave failed:', err)
        setSaveStatus(null)
      }
    }, 600)
  }

  function setActiveBlock(el) {
    if (activeBlockRef.current) activeBlockRef.current.classList.remove('active-block')
    el.classList.add('active-block')
    activeBlockRef.current = el
  }

  function setActiveCodeLine(el) {
    if (activeCodeLineRef.current) activeCodeLineRef.current.classList.remove('active-code-line')
    activeCodeLineRef.current = el ?? null
    if (el) el.classList.add('active-code-line')
  }

  function scrollPreviewToLine(line) {
    const editor = editorRef.current
    const preview = previewRef.current
    if (!preview) return

    const elements = [...preview.querySelectorAll('[data-line]')]
    if (!elements.length) return
    let best = elements[0]
    for (const el of elements) {
      if (parseInt(el.dataset.line, 10) <= line) best = el
    }

    setActiveBlock(best)

    // Secondary highlight: specific line within a code block.
    setActiveCodeLine(null)
    if (editor) {
      const codeInfo = getCodeBlockInfo(editor.value, line)
      if (codeInfo && codeInfo.lineWithinBlock >= 1) {
        const pre = preview.querySelector(`[data-line="${codeInfo.sourceLine}"]`)
        const codeLine = pre?.querySelector(`[data-code-line="${codeInfo.lineWithinBlock}"]`)
        if (codeLine) setActiveCodeLine(codeLine)
      }
    }

    // Scroll preview so the matched element sits at the same fractional
    // viewport position as the cursor does in the editor.
    const lineHeight = editor ? (parseFloat(getComputedStyle(editor).lineHeight) || 22) : 22
    const cursorPx = editor ? (line - 1) * lineHeight - editor.scrollTop : 0
    const relY = editor ? Math.max(0, Math.min(1, cursorPx / editor.clientHeight)) : 0.33

    const previewRect = preview.getBoundingClientRect()
    const elRect = best.getBoundingClientRect()
    const elOffsetInScroll = elRect.top - previewRect.top + preview.scrollTop
    const target = Math.max(0, Math.min(
      elOffsetInScroll - relY * preview.clientHeight,
      preview.scrollHeight - preview.clientHeight
    ))
    preview.scrollTo({ top: target, behavior: 'smooth' })
  }

  function handleEditorActivity() {
    const editor = editorRef.current
    if (!editor) return
    const line = editor.value.substring(0, editor.selectionStart).split('\n').length
    scrollPreviewToLine(line)
  }

  // Re-renders the contentEditable preview from `content` whenever it
  // changes — except right after a preview-originated edit (suppressed via
  // suppressNextSyncRef), since replacing innerHTML there would blow away
  // the caret mid-edit. Source-textarea edits (which don't set that flag)
  // always flow through to re-render the preview, same as before.
  useEffect(() => {
    const article = articleRef.current
    if (!article) return
    if (suppressNextSyncRef.current) {
      suppressNextSyncRef.current = false
      return
    }
    article.innerHTML = renderMarkdownToHtml(content ?? '')
    freezeCodeBlocks(article)
  }, [content])

  // Converts the live preview DOM back into markdown (via Turndown) and
  // writes it into `content` + triggers autosave — the reverse direction of
  // the effect above. Called after every preview edit (debounced for plain
  // typing, immediately for toolbar actions).
  //
  // Note: this re-serialises the whole document each time, not just the
  // edited part, so it can normalise unrelated formatting conventions
  // (heading style, bullet/emphasis characters) elsewhere in the file —
  // the turndownService options above are set to match this app's own
  // output style to minimise that.
  const syncPreviewToMarkdown = useCallback(function syncPreviewToMarkdown() {
    const article = articleRef.current
    if (!article) return
    const markdown = turndownService.turndown(article.innerHTML)
    suppressNextSyncRef.current = true
    setContent(markdown)
    scheduleAutosave(markdown)
  }, [])

  const handlePreviewInput = useCallback(function handlePreviewInput() {
    if (previewSyncTimerRef.current) clearTimeout(previewSyncTimerRef.current)
    previewSyncTimerRef.current = setTimeout(syncPreviewToMarkdown, 400)
  }, [syncPreviewToMarkdown])

  const applyBold = useCallback(function applyBold() {
    document.execCommand('bold')
    syncPreviewToMarkdown()
  }, [syncPreviewToMarkdown])

  const applyItalic = useCallback(function applyItalic() {
    document.execCommand('italic')
    syncPreviewToMarkdown()
  }, [syncPreviewToMarkdown])

  // Toggles a <mark> wrap around the current preview selection directly in
  // the DOM (there's no execCommand for it) — unwraps if the selection sits
  // fully inside an existing <mark>, otherwise wraps it in a new one.
  const toggleHighlight = useCallback(function toggleHighlight() {
    const article = articleRef.current
    const selection = window.getSelection()
    if (!article || !selection || selection.rangeCount === 0 || selection.isCollapsed) return
    const range = selection.getRangeAt(0)
    if (!article.contains(range.commonAncestorContainer)) return

    let node = range.commonAncestorContainer
    if (node.nodeType === 3) node = node.parentNode
    const existingMark = node.closest ? node.closest('mark') : null
    if (existingMark && article.contains(existingMark)) {
      const parent = existingMark.parentNode
      while (existingMark.firstChild) parent.insertBefore(existingMark.firstChild, existingMark)
      parent.removeChild(existingMark)
    } else {
      const mark = document.createElement('mark')
      try {
        range.surroundContents(mark)
      } catch {
        // Selection spans multiple elements (surroundContents can't handle
        // that) — extract and re-wrap instead.
        const frag = range.extractContents()
        mark.appendChild(frag)
        range.insertNode(mark)
      }
    }
    selection.removeAllRanges()
    syncPreviewToMarkdown()
  }, [syncPreviewToMarkdown])

  useEffect(() => {
    function handleKeyDown(e) {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const article = articleRef.current
      const selection = window.getSelection()
      if (!article || !selection || selection.rangeCount === 0) return
      if (!article.contains(selection.anchorNode)) return
      if (e.key === 'b' || e.key === 'B') { e.preventDefault(); applyBold() }
      else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); applyItalic() }
      else if ((e.key === 'h' || e.key === 'H') && e.shiftKey) { e.preventDefault(); toggleHighlight() }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [applyBold, applyItalic, toggleHighlight])

  const [hasPreviewSelection, setHasPreviewSelection] = useState(false)

  useEffect(() => {
    function handleSelectionChange() {
      const article = articleRef.current
      const selection = window.getSelection()
      setHasPreviewSelection(!!(
        article && selection && selection.rangeCount > 0 && !selection.isCollapsed &&
        article.contains(selection.anchorNode) && article.contains(selection.focusNode)
      ))
    }
    document.addEventListener('selectionchange', handleSelectionChange)
    return () => document.removeEventListener('selectionchange', handleSelectionChange)
  }, [])

  return (
    <div className="app">
      <header className="toolbar">
        <span className="app-title">Markdown Editor</span>
        {fileName && <span className="file-name">{fileName}</span>}
        {saveStatus && (
          <span className={`save-status ${saveStatus}`}>
            {saveStatus === 'saving' ? 'Saving…' : 'Saved'}
          </span>
        )}
        {content && (
          <button
            className={`toggle-btn ${editorOpen ? 'active' : ''}`}
            onClick={() => setEditorOpen(o => !o)}
            title="Toggle source editor"
          >
            {'</>'}
          </button>
        )}
        {history.length > 0 && (
          <div className="history-dropdown" ref={historyMenuRef}>
            <button
              className={`history-btn ${historyOpen ? 'active' : ''}`}
              onClick={() => setHistoryOpen(o => !o)}
              title="Recently opened files"
            >
              Recent ▾
            </button>
            {historyOpen && (
              <div className="history-menu">
                {supportsDirPicker && (
                  <div className="history-root-row">
                    <span className="history-root-label" title={rootDirName ? `Paths shown relative to "${rootDirName}"` : 'No root folder set — pick one to show full paths'}>
                      {rootDirName ? `Root: ${rootDirName}` : 'No root folder set'}
                    </span>
                    <button className="history-root-btn" onClick={chooseRootFolder}>
                      {rootDirName ? 'Change' : 'Set root'}
                    </button>
                    {rootDirName && (
                      <button className="history-root-btn" onClick={clearRootFolder}>
                        Clear
                      </button>
                    )}
                  </div>
                )}
                <ul className="history-list">
                {history.map(entry => (
                  <li key={entry.path} className="history-row">
                    <button className="history-item" onClick={() => reopenFromHistory(entry)} title={entry.path}>
                      {entry.path}
                    </button>
                    <button
                      className="history-delete"
                      onClick={(e) => removeFromHistory(entry.path, e)}
                      title="Remove from history"
                      aria-label={`Remove ${entry.path} from history`}
                    >
                      ×
                    </button>
                  </li>
                ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <button className="open-btn" onClick={openFile}>
          Open file
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".md,.markdown,.txt"
          style={{ display: 'none' }}
          onChange={handleFileInput}
        />
      </header>

      {content ? (
        <main className={`workspace ${editorOpen ? 'split' : ''}`}>
          {editorOpen && (
            <div className="editor-panel">
              <textarea
                ref={editorRef}
                className="editor"
                value={content}
                onChange={e => { setContent(e.target.value); scheduleAutosave(e.target.value) }}
                onKeyUp={handleEditorActivity}
                onClick={handleEditorActivity}
                spellCheck={false}
              />
            </div>
          )}
          <div
            className="preview-panel"
            ref={previewRef}
          >
            <div className="preview-toolbar">
              <button
                type="button"
                className="format-btn"
                disabled={!hasPreviewSelection}
                onMouseDown={e => e.preventDefault()}
                onClick={applyBold}
                title="Bold (Ctrl+B)"
              >
                <b>B</b>
              </button>
              <button
                type="button"
                className="format-btn"
                disabled={!hasPreviewSelection}
                onMouseDown={e => e.preventDefault()}
                onClick={applyItalic}
                title="Italic (Ctrl+I)"
              >
                <i>I</i>
              </button>
              <button
                type="button"
                className="format-btn format-btn-highlight"
                disabled={!hasPreviewSelection}
                onMouseDown={e => e.preventDefault()}
                onClick={toggleHighlight}
                title="Highlight (Ctrl+Shift+H)"
              >
                H
              </button>
              <span className="preview-toolbar-hint">Type directly to edit, or select text to format</span>
            </div>
            <article
              className="markdown-body"
              ref={articleRef}
              contentEditable
              suppressContentEditableWarning
              onInput={handlePreviewInput}
            />
          </div>
        </main>
      ) : (
        <main className="workspace">
          <div className="empty-state">
            {pendingReopen ? (
              <div className="reopen-banner">
                <p>Reopen last file, <strong>{pendingReopen.name}</strong>?</p>
                <div className="reopen-banner-actions">
                  <button className="open-btn" onClick={confirmReopenLast}>Reopen</button>
                  <button className="reopen-dismiss" onClick={dismissReopenLast}>Dismiss</button>
                </div>
              </div>
            ) : (
              <p>No file open</p>
            )}
            <button className="open-btn large" onClick={openFile}>
              Choose a Markdown file
            </button>
          </div>
        </main>
      )}
    </div>
  )
}
