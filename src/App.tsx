import fontkit from '@pdf-lib/fontkit'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Loader,
  Pencil,
  RotateCcw,
  Trash2,
  UploadCloud,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
} from 'react'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import type {
  PageViewport,
  PDFDocumentProxy,
  PDFPageProxy,
} from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url'
import { PDFDocument as PDFLibDocument, rgb, type PDFFont } from 'pdf-lib'
import './App.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

const MIN_ZOOM = 0.7
const MAX_ZOOM = 2.1
const ZOOM_STEP = 0.15
const HEBREW_PATTERN = /[\u0590-\u05ff]/

type PdfTextItem = {
  str: string
  transform: number[]
  width: number
  height: number
  fontName: string
}

type TextBox = {
  left: number
  top: number
  width: number
  height: number
}

type PdfBox = {
  x: number
  y: number
  width: number
  height: number
  fontSize: number
}

type TextRun = {
  id: string
  pageNumber: number
  text: string
  viewportBox: TextBox
  pdfBox: PdfBox
}

type TextEdit = {
  id: string
  pageNumber: number
  originalText: string
  value: string
  pdfBox: PdfBox
}

type PageView = {
  page: PDFPageProxy
  viewport: PageViewport
  textRuns: TextRun[]
}

type FontSet = {
  latin: PDFFont
  hebrew: PDFFont
}

const isPdfTextItem = (item: unknown): item is PdfTextItem => {
  if (!item || typeof item !== 'object') {
    return false
  }

  const candidate = item as Partial<PdfTextItem>
  return (
    typeof candidate.str === 'string' &&
    Array.isArray(candidate.transform) &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number'
  )
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

const formatFileSize = (size: number) => {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

const getEditedFileName = (fileName: string) =>
  fileName.replace(/\.pdf$/i, '') + '-edited.pdf'

const cloneArrayBuffer = (buffer: ArrayBuffer) => buffer.slice(0)

const readBlobAsArrayBuffer = (blob: Blob) => {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer()
  }

  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()

    reader.onerror = () => {
      reject(reader.error ?? new Error('Could not read the selected file.'))
    }
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result)
      } else {
        reject(new Error('Could not read the selected file.'))
      }
    }
    reader.readAsArrayBuffer(blob)
  })
}

const getBoxStyle = (box: TextBox): CSSProperties => ({
  height: `${box.height}px`,
  left: `${box.left}px`,
  top: `${box.top}px`,
  width: `${box.width}px`,
})

const getTextRunFromItem = (
  item: PdfTextItem,
  index: number,
  pageNumber: number,
  viewport: PageViewport,
): TextRun | null => {
  const text = item.str.trim()

  if (!text) {
    return null
  }

  const transformed = pdfjsLib.Util.transform(viewport.transform, item.transform)
  const viewportFontHeight =
    Math.hypot(transformed[2], transformed[3]) ||
    Math.max(8, item.height * viewport.scale)
  const viewportWidth = Math.max(10, item.width * viewport.scale)
  const viewportHeight = Math.max(10, viewportFontHeight)
  const pdfFontSize =
    Math.abs(item.transform[3]) || Math.abs(item.transform[0]) || item.height

  return {
    id: `${pageNumber}:${index}`,
    pageNumber,
    text,
    viewportBox: {
      height: viewportHeight,
      left: transformed[4],
      top: transformed[5] - viewportHeight,
      width: viewportWidth,
    },
    pdfBox: {
      fontSize: Math.max(4, pdfFontSize),
      height: Math.max(4, item.height || pdfFontSize),
      width: Math.max(4, item.width),
      x: item.transform[4],
      y: item.transform[5],
    },
  }
}

const getPdfTextRuns = async (
  page: PDFPageProxy,
  pageNumber: number,
  viewport: PageViewport,
) => {
  const textContent = await page.getTextContent()

  return textContent.items
    .map((item, index) =>
      isPdfTextItem(item)
        ? getTextRunFromItem(item, index, pageNumber, viewport)
        : null,
    )
    .filter((run): run is TextRun => Boolean(run))
}

const downloadBytes = (bytes: Uint8Array, fileName: string) => {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

const getFontForText = (text: string, fonts: FontSet) =>
  HEBREW_PATTERN.test(text) ? fonts.hebrew : fonts.latin

const splitLongWord = (word: string, font: PDFFont, size: number, maxWidth: number) => {
  const segments: string[] = []
  let current = ''

  for (const character of word) {
    const next = current + character

    if (!current || font.widthOfTextAtSize(next, size) <= maxWidth) {
      current = next
    } else {
      segments.push(current)
      current = character
    }
  }

  if (current) {
    segments.push(current)
  }

  return segments
}

const wrapText = (text: string, font: PDFFont, size: number, maxWidth: number) => {
  const lines: string[] = []

  for (const hardLine of text.split(/\r?\n/)) {
    const words = hardLine.split(/\s+/).filter(Boolean)

    if (!words.length) {
      lines.push('')
      continue
    }

    let currentLine = ''

    for (const word of words) {
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        if (currentLine) {
          lines.push(currentLine)
          currentLine = ''
        }

        const segments = splitLongWord(word, font, size, maxWidth)
        lines.push(...segments.slice(0, -1))
        currentLine = segments[segments.length - 1] ?? ''
        continue
      }

      const nextLine = currentLine ? `${currentLine} ${word}` : word

      if (
        !currentLine ||
        font.widthOfTextAtSize(nextLine, size) <= maxWidth
      ) {
        currentLine = nextLine
      } else {
        lines.push(currentLine)
        currentLine = word
      }
    }

    lines.push(currentLine)
  }

  return lines.length ? lines : ['']
}

const loadFontBytes = async (fileName: string) => {
  const response = await fetch(`${import.meta.env.BASE_URL}fonts/${fileName}`)

  if (!response.ok) {
    throw new Error(`Could not load ${fileName}`)
  }

  if (typeof response.arrayBuffer === 'function') {
    return response.arrayBuffer()
  }

  return readBlobAsArrayBuffer(await response.blob())
}

const exportEditedPdf = async (
  originalBytes: ArrayBuffer,
  edits: TextEdit[],
) => {
  const pdfDoc = await PDFLibDocument.load(cloneArrayBuffer(originalBytes))
  pdfDoc.registerFontkit(fontkit)

  const [latinFontBytes, hebrewFontBytes] = await Promise.all([
    loadFontBytes('NotoSans-Regular.ttf'),
    loadFontBytes('NotoSansHebrew-Regular.ttf'),
  ])
  const fonts: FontSet = {
    hebrew: await pdfDoc.embedFont(hebrewFontBytes, { subset: true }),
    latin: await pdfDoc.embedFont(latinFontBytes, { subset: true }),
  }

  for (const edit of edits) {
    const page = pdfDoc.getPage(edit.pageNumber - 1)
    const pageSize = page.getSize()
    const font = getFontForText(edit.value, fonts)
    const fontSize = clamp(edit.pdfBox.fontSize, 5, 72)
    const maxAllowedWidth = Math.max(36, pageSize.width - edit.pdfBox.x - 12)
    const rawTextWidth = Math.max(
      edit.pdfBox.width,
      font.widthOfTextAtSize(edit.value || ' ', fontSize),
    )
    const desiredWidth = Math.min(maxAllowedWidth, rawTextWidth)
    const lines = wrapText(edit.value, font, fontSize, desiredWidth)
    const lineHeight = fontSize * 1.18
    const visibleTextWidth = Math.max(
      edit.pdfBox.width,
      ...lines.map((line) => font.widthOfTextAtSize(line || ' ', fontSize)),
    )
    const blockWidth = Math.min(maxAllowedWidth, visibleTextWidth)
    const paddingX = Math.max(1.5, fontSize * 0.1)
    const paddingY = Math.max(1.5, fontSize * 0.22)
    const maskX = clamp(edit.pdfBox.x - paddingX, 0, pageSize.width)
    const textTop = Math.min(pageSize.height, edit.pdfBox.y + fontSize * 0.85)
    const textBottom = Math.max(
      0,
      edit.pdfBox.y - fontSize * 0.28 - lineHeight * (lines.length - 1),
    )
    const maskY = clamp(textBottom - paddingY, 0, pageSize.height)
    const maskWidth = Math.min(pageSize.width - maskX, blockWidth + paddingX * 2)
    const maskHeight = Math.min(
      pageSize.height - maskY,
      textTop - textBottom + paddingY * 2,
    )

    page.drawRectangle({
      color: rgb(1, 1, 1),
      height: Math.max(fontSize, maskHeight),
      width: Math.max(edit.pdfBox.width, maskWidth),
      x: maskX,
      y: maskY,
    })

    lines.forEach((line, lineIndex) => {
      if (!line) {
        return
      }

      page.drawText(line, {
        color: rgb(0.04, 0.04, 0.04),
        font,
        size: fontSize,
        x: edit.pdfBox.x,
        y: edit.pdfBox.y - lineIndex * lineHeight,
      })
    })
  }

  return pdfDoc.save()
}

function PdfPageCanvas({
  edits,
  onSelectRun,
  pageView,
  selectedRunId,
}: {
  edits: Record<string, TextEdit>
  onSelectRun: (run: TextRun) => void
  pageView: PageView
  selectedRunId: string | null
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [isRendering, setIsRendering] = useState(true)

  useEffect(() => {
    const canvas = canvasRef.current

    if (!canvas) {
      return
    }

    const outputScale = window.devicePixelRatio || 1
    const transform =
      outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]

    canvas.width = Math.floor(pageView.viewport.width * outputScale)
    canvas.height = Math.floor(pageView.viewport.height * outputScale)
    canvas.style.width = `${pageView.viewport.width}px`
    canvas.style.height = `${pageView.viewport.height}px`

    const context = canvas.getContext('2d')

    if (!context) {
      return
    }

    const renderTask = pageView.page.render({
      canvas,
      canvasContext: context,
      transform,
      viewport: pageView.viewport,
    })
    let isActive = true

    setIsRendering(true)

    renderTask.promise
      .then(() => {
        if (isActive) {
          setIsRendering(false)
        }
      })
      .catch((error: unknown) => {
        if (
          isActive &&
          error instanceof Error &&
          error.name !== 'RenderingCancelledException'
        ) {
          setIsRendering(false)
        }
      })

    return () => {
      isActive = false
      renderTask.cancel()
    }
  }, [pageView])

  return (
    <div
      className="page-frame"
      style={{
        height: `${pageView.viewport.height}px`,
        width: `${pageView.viewport.width}px`,
      }}
    >
      <canvas ref={canvasRef} />
      <div className="text-layer">
        {pageView.textRuns.map((run) => {
          const edit = edits[run.id]
          const boxStyle = getBoxStyle(run.viewportBox)
          const previewStyle: CSSProperties = {
            ...boxStyle,
            fontSize: `${Math.max(8, run.viewportBox.height * 0.72)}px`,
            lineHeight: `${Math.max(10, run.viewportBox.height)}px`,
          }

          return (
            <div className="text-run" key={run.id}>
              {edit ? (
                <div className="text-preview" style={previewStyle}>
                  {edit.value}
                </div>
              ) : null}
              <button
                aria-label={`Edit text: ${run.text}`}
                className={[
                  'text-target',
                  selectedRunId === run.id ? 'is-selected' : '',
                  edit ? 'is-edited' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => onSelectRun(run)}
                style={boxStyle}
                title="Edit text"
                type="button"
              />
            </div>
          )
        })}
      </div>
      {isRendering ? (
        <div className="render-state">
          <Loader aria-hidden="true" size={18} />
        </div>
      ) : null}
    </div>
  )
}

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null)
  const [originalBytes, setOriginalBytes] = useState<ArrayBuffer | null>(null)
  const [fileName, setFileName] = useState('')
  const [fileSize, setFileSize] = useState(0)
  const [pageCount, setPageCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [zoom, setZoom] = useState(1.2)
  const [pageView, setPageView] = useState<PageView | null>(null)
  const [pageStatus, setPageStatus] = useState<'idle' | 'loading' | 'ready'>(
    'idle',
  )
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [draftText, setDraftText] = useState('')
  const [edits, setEdits] = useState<Record<string, TextEdit>>({})
  const [isDragging, setIsDragging] = useState(false)
  const [isLoadingFile, setIsLoadingFile] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [error, setError] = useState('')

  const editList = useMemo(() => Object.values(edits), [edits])
  const selectedRun = useMemo(
    () =>
      pageView?.textRuns.find((run) => run.id === selectedRunId) ?? null,
    [pageView, selectedRunId],
  )
  const selectedEdit = selectedRun ? edits[selectedRun.id] : undefined
  const currentPageEditCount = editList.filter(
    (edit) => edit.pageNumber === currentPage,
  ).length

  useEffect(
    () => () => {
      void pdfDocumentRef.current?.cleanup()
    },
    [],
  )

  useEffect(() => {
    if (!selectedRun) {
      setDraftText('')
      return
    }

    setDraftText(selectedEdit?.value ?? selectedRun.text)
  }, [selectedEdit?.value, selectedRun])

  useEffect(() => {
    if (!selectedRun) {
      return
    }

    textareaRef.current?.focus()
  }, [selectedRun])

  useEffect(() => {
    if (!pdfDocument) {
      setPageView(null)
      setPageStatus('idle')
      return
    }

    let isActive = true

    setPageStatus('loading')
    setPageView(null)
    setSelectedRunId((runId) =>
      runId?.startsWith(`${currentPage}:`) ? runId : null,
    )

    const loadPage = async () => {
      const page = await pdfDocument.getPage(currentPage)
      const viewport = page.getViewport({ scale: zoom })
      const textRuns = await getPdfTextRuns(page, currentPage, viewport)

      if (isActive) {
        setPageView({ page, textRuns, viewport })
        setPageStatus('ready')
      }
    }

    loadPage().catch((loadError: unknown) => {
      if (isActive) {
        setPageStatus('idle')
        setError(
          loadError instanceof Error
            ? loadError.message
            : 'Could not render this page.',
        )
      }
    })

    return () => {
      isActive = false
    }
  }, [currentPage, pdfDocument, zoom])

  const loadPdfFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setError('Choose a PDF file.')
      return
    }

    setIsLoadingFile(true)
    setError('')

    try {
      const fileBytes = await readBlobAsArrayBuffer(file)
      const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(cloneArrayBuffer(fileBytes)),
      })
      const loadedPdf = await loadingTask.promise

      await pdfDocumentRef.current?.cleanup()
      pdfDocumentRef.current = loadedPdf

      setPdfDocument(loadedPdf)
      setOriginalBytes(cloneArrayBuffer(fileBytes))
      setFileName(file.name)
      setFileSize(file.size)
      setPageCount(loadedPdf.numPages)
      setCurrentPage(1)
      setSelectedRunId(null)
      setDraftText('')
      setEdits({})
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Could not open this PDF.',
      )
    } finally {
      setIsLoadingFile(false)
    }
  }, [])

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      let nextFile: File | undefined

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]

        if (file?.name.toLowerCase().endsWith('.pdf')) {
          nextFile = file
          break
        }
      }

      if (!nextFile) {
        setError('Choose a PDF file.')
        return
      }

      void loadPdfFile(nextFile)
    },
    [loadPdfFile],
  )

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) {
      handleFiles(event.target.files)
      event.target.value = ''
    }
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(false)

    if (event.dataTransfer.files.length) {
      handleFiles(event.dataTransfer.files)
    }
  }

  const saveSelectedEdit = () => {
    if (!selectedRun) {
      return
    }

    setEdits((currentEdits) => {
      const nextEdits = { ...currentEdits }

      if (draftText === selectedRun.text) {
        delete nextEdits[selectedRun.id]
      } else {
        nextEdits[selectedRun.id] = {
          id: selectedRun.id,
          originalText: selectedRun.text,
          pageNumber: selectedRun.pageNumber,
          pdfBox: selectedRun.pdfBox,
          value: draftText,
        }
      }

      return nextEdits
    })
  }

  const removeSelectedEdit = () => {
    if (!selectedRun) {
      return
    }

    setEdits((currentEdits) => {
      const nextEdits = { ...currentEdits }
      delete nextEdits[selectedRun.id]
      return nextEdits
    })
    setDraftText(selectedRun.text)
  }

  const clearAllEdits = () => {
    setEdits({})
    setDraftText(selectedRun?.text ?? '')
  }

  const downloadPdf = async () => {
    if (!originalBytes) {
      return
    }

    setIsExporting(true)
    setError('')

    try {
      const editedBytes = editList.length
        ? await exportEditedPdf(originalBytes, editList)
        : new Uint8Array(cloneArrayBuffer(originalBytes))

      downloadBytes(editedBytes, getEditedFileName(fileName || 'document.pdf'))
    } catch (exportError) {
      setError(
        exportError instanceof Error
          ? exportError.message
          : 'Could not export the edited PDF.',
      )
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <main
      className={['app-shell', isDragging ? 'is-dragging' : '']
        .filter(Boolean)
        .join(' ')}
      onDragLeave={() => setIsDragging(false)}
      onDragOver={(event) => {
        event.preventDefault()
        setIsDragging(true)
      }}
      onDrop={handleDrop}
    >
      <input
        accept="application/pdf,.pdf"
        className="file-input"
        onChange={handleInputChange}
        ref={fileInputRef}
        type="file"
      />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <FileText aria-hidden="true" size={20} />
          </span>
          <div>
            <h1>PDF Text Editor</h1>
            <p>
              {fileName
                ? `${fileName} · ${formatFileSize(fileSize)}`
                : 'Browser-based PDF text edits'}
            </p>
          </div>
        </div>

        <div className="toolbar" aria-label="PDF actions">
          <button
            aria-label="Upload PDF"
            className="icon-button"
            onClick={() => fileInputRef.current?.click()}
            title="Upload PDF"
            type="button"
          >
            <UploadCloud aria-hidden="true" size={18} />
          </button>
          {pdfDocument ? (
            <>
              <div className="segmented-control" aria-label="Page controls">
                <button
                  aria-label="Previous page"
                  disabled={currentPage <= 1}
                  onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                  title="Previous page"
                  type="button"
                >
                  <ChevronLeft aria-hidden="true" size={17} />
                </button>
                <span>
                  {currentPage} / {pageCount}
                </span>
                <button
                  aria-label="Next page"
                  disabled={currentPage >= pageCount}
                  onClick={() =>
                    setCurrentPage((page) => Math.min(pageCount, page + 1))
                  }
                  title="Next page"
                  type="button"
                >
                  <ChevronRight aria-hidden="true" size={17} />
                </button>
              </div>
              <div className="segmented-control" aria-label="Zoom controls">
                <button
                  aria-label="Zoom out"
                  disabled={zoom <= MIN_ZOOM}
                  onClick={() =>
                    setZoom((currentZoom) =>
                      clamp(currentZoom - ZOOM_STEP, MIN_ZOOM, MAX_ZOOM),
                    )
                  }
                  title="Zoom out"
                  type="button"
                >
                  <ZoomOut aria-hidden="true" size={17} />
                </button>
                <span>{Math.round(zoom * 100)}%</span>
                <button
                  aria-label="Zoom in"
                  disabled={zoom >= MAX_ZOOM}
                  onClick={() =>
                    setZoom((currentZoom) =>
                      clamp(currentZoom + ZOOM_STEP, MIN_ZOOM, MAX_ZOOM),
                    )
                  }
                  title="Zoom in"
                  type="button"
                >
                  <ZoomIn aria-hidden="true" size={17} />
                </button>
              </div>
              <button
                className="download-button"
                disabled={isExporting}
                onClick={() => void downloadPdf()}
                type="button"
              >
                {isExporting ? (
                  <Loader aria-hidden="true" size={17} />
                ) : (
                  <Download aria-hidden="true" size={17} />
                )}
                Download
              </button>
            </>
          ) : null}
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      {!pdfDocument ? (
        <section className="upload-panel">
          <div className="drop-zone">
            <UploadCloud aria-hidden="true" size={40} />
            <div>
              <h2>{isLoadingFile ? 'Opening PDF' : 'Drop a PDF here'}</h2>
              <p>or choose a file to start editing text</p>
            </div>
            <button
              className="primary-button"
              disabled={isLoadingFile}
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              {isLoadingFile ? (
                <Loader aria-hidden="true" size={17} />
              ) : (
                <UploadCloud aria-hidden="true" size={17} />
              )}
              Choose PDF
            </button>
          </div>
        </section>
      ) : (
        <section className="editor-layout">
          <div className="viewer-panel">
            <div className="viewer-scroll">
              {pageView && pageStatus === 'ready' ? (
                <PdfPageCanvas
                  edits={edits}
                  onSelectRun={(run) => setSelectedRunId(run.id)}
                  pageView={pageView}
                  selectedRunId={selectedRunId}
                />
              ) : (
                <div className="page-placeholder">
                  <Loader aria-hidden="true" size={22} />
                </div>
              )}
            </div>
          </div>

          <aside className="edit-panel">
            <div className="panel-section">
              <div className="panel-heading">
                <Pencil aria-hidden="true" size={18} />
                <h2>Edit text</h2>
              </div>

              {selectedRun ? (
                <div className="edit-form">
                  <label htmlFor="selected-text">Selected text</label>
                  <textarea
                    id="selected-text"
                    onChange={(event) => setDraftText(event.target.value)}
                    ref={textareaRef}
                    rows={6}
                    value={draftText}
                  />
                  <div className="form-actions">
                    <button
                      className="primary-button"
                      onClick={saveSelectedEdit}
                      type="button"
                    >
                      <Pencil aria-hidden="true" size={16} />
                      Apply
                    </button>
                    <button
                      className="ghost-button"
                      disabled={!selectedEdit}
                      onClick={removeSelectedEdit}
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" size={16} />
                      Revert
                    </button>
                  </div>
                </div>
              ) : (
                <div className="empty-selection">
                  <Pencil aria-hidden="true" size={22} />
                  <p>Select text on the page.</p>
                </div>
              )}
            </div>

            <div className="panel-section">
              <div className="panel-heading">
                <FileText aria-hidden="true" size={18} />
                <h2>Changes</h2>
                <span className="count-pill">{editList.length}</span>
              </div>
              <div className="edit-summary">
                <span>{currentPageEditCount} on this page</span>
                <button
                  className="icon-button"
                  disabled={!editList.length}
                  onClick={clearAllEdits}
                  title="Clear all changes"
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={16} />
                </button>
              </div>
              <div className="change-list">
                {editList.length ? (
                  editList.map((edit) => (
                    <button
                      className={[
                        'change-item',
                        selectedRunId === edit.id ? 'is-active' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      key={edit.id}
                      onClick={() => {
                        setCurrentPage(edit.pageNumber)
                        setSelectedRunId(edit.id)
                      }}
                      type="button"
                    >
                      <span>Page {edit.pageNumber}</span>
                      <strong>{edit.value || '(blank)'}</strong>
                    </button>
                  ))
                ) : (
                  <p className="muted">No changes yet.</p>
                )}
              </div>
            </div>
          </aside>
        </section>
      )}

      {isDragging ? <div className="drop-overlay">Drop PDF to open</div> : null}
    </main>
  )
}

export default App
