import { useState, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github.css'
import './App.css'

function rehypeAddLineNumbers() {
  return (tree) => {
    function walk(node) {
      if (node.type === 'element' && node.position) {
        if (!node.properties) node.properties = {}
        node.properties['data-line'] = node.position.start.line
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

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlight, rehypeAddLineNumbers, rehypeWrapCodeLines]

export default function App() {
  const [content, setContent] = useState(null)
  const [fileName, setFileName] = useState(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const inputRef = useRef(null)
  const editorRef = useRef(null)
  const previewRef = useRef(null)
  const activeBlockRef = useRef(null)
  const activeCodeLineRef = useRef(null)

  function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (ev) => setContent(ev.target.result)
    reader.readAsText(file)
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

  function scrollEditorToLine(line, relY = 0.33) {
    const editor = editorRef.current
    if (!editor) return
    const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 22
    const top = Math.min(
      Math.max(0, (line - 1) * lineHeight - relY * editor.clientHeight),
      editor.scrollHeight - editor.clientHeight
    )
    editor.scrollTo({ top, behavior: 'smooth' })
  }

  function handleEditorActivity() {
    const editor = editorRef.current
    if (!editor) return
    const line = editor.value.substring(0, editor.selectionStart).split('\n').length
    scrollPreviewToLine(line)
  }

  function handlePreviewClick(e) {
    if (!editorOpen) return
    let el = e.target
    while (el && el !== previewRef.current) {
      if (el.dataset?.line) {
        const previewRect = previewRef.current.getBoundingClientRect()
        const elRect = el.getBoundingClientRect()
        const relY = Math.max(0, Math.min(1, (elRect.top - previewRect.top) / previewRect.height))
        setActiveBlock(el)
        setActiveCodeLine(null)
        scrollEditorToLine(parseInt(el.dataset.line, 10), relY)
        return
      }
      el = el.parentElement
    }
  }

  return (
    <div className="app">
      <header className="toolbar">
        <span className="app-title">Markdown Viewer</span>
        {fileName && <span className="file-name">{fileName}</span>}
        {content && (
          <button
            className={`toggle-btn ${editorOpen ? 'active' : ''}`}
            onClick={() => setEditorOpen(o => !o)}
            title="Toggle source editor"
          >
            {'</>'}
          </button>
        )}
        <button className="open-btn" onClick={() => inputRef.current.click()}>
          Open file
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".md,.markdown,.txt"
          style={{ display: 'none' }}
          onChange={handleFile}
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
                onChange={e => setContent(e.target.value)}
                onKeyUp={handleEditorActivity}
                onClick={handleEditorActivity}
                spellCheck={false}
              />
            </div>
          )}
          <div
            className="preview-panel"
            ref={previewRef}
            onClick={handlePreviewClick}
          >
            <article className="markdown-body">
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
                {content}
              </ReactMarkdown>
            </article>
          </div>
        </main>
      ) : (
        <main className="workspace">
          <div className="empty-state">
            <p>No file open</p>
            <button className="open-btn large" onClick={() => inputRef.current.click()}>
              Choose a Markdown file
            </button>
          </div>
        </main>
      )}
    </div>
  )
}
