import { expect, test } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const createSamplePdf = async (filePath: string) => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const font = await pdf.embedFont(StandardFonts.Helvetica)

  page.drawText('Invoice Number 12345', {
    color: rgb(0, 0, 0),
    font,
    size: 18,
    x: 72,
    y: 700,
  })
  page.drawText('Customer: Jane Example', {
    color: rgb(0, 0, 0),
    font,
    size: 12,
    x: 72,
    y: 670,
  })
  page.drawText('Total due: 250 USD', {
    color: rgb(0, 0, 0),
    font,
    size: 12,
    x: 72,
    y: 640,
  })

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, await pdf.save())
}

test('uploads, edits, and downloads a PDF', async ({ page }, testInfo) => {
  const samplePath = testInfo.outputPath('sample.pdf')
  const editedPath = testInfo.outputPath('sample-edited.pdf')

  await createSamplePdf(samplePath)
  await page.addInitScript(() => {
    Object.defineProperty(Blob.prototype, 'arrayBuffer', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(Response.prototype, 'arrayBuffer', {
      configurable: true,
      value: undefined,
    })
  })

  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'PDF Text Editor' })).toBeVisible()

  await page.locator('input[type="file"]').setInputFiles(samplePath)
  await expect(page.locator('.page-frame canvas')).toBeVisible()

  const editableText = page.getByLabel('Edit text: Invoice Number 12345')
  await expect(editableText).toBeVisible()
  await editableText.click()

  await expect(page.getByLabel('Selected text')).toHaveValue(
    'Invoice Number 12345',
  )
  await page.getByLabel('Selected text').fill('Invoice Number 98765')
  await page.getByRole('button', { name: 'Apply' }).click()

  await expect(page.locator('.change-item')).toContainText(
    'Invoice Number 98765',
  )
  await expect(page.locator('.text-preview')).toContainText(
    'Invoice Number 98765',
  )

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download' }).click()
  const download = await downloadPromise

  expect(download.suggestedFilename()).toBe('sample-edited.pdf')
  await download.saveAs(editedPath)

  const bytes = await readFile(editedPath)
  const exportedPdf = await PDFDocument.load(bytes)

  expect(bytes.byteLength).toBeGreaterThan(1_000)
  expect(exportedPdf.getPageCount()).toBe(1)
})
