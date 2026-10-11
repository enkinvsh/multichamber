import { isFilesystemError } from "@/lib/api/files-errors"
import { SAVED_FILES_LIMIT, createContextPart, type ContextPart } from "@/lib/messages/contextParts"
import { isDocumentAttachmentFilename } from "./attachment-files"

// Порог из ТЗ zeny: крупнее этого модель вложение не получает, только диск —
// иначе base64 в prompt_async раздувает запрос до десятков мегабайт.
export const MODEL_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024

const MODEL_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
])
const MODEL_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "pdf"])

export type AttachmentDestination = "model-and-disk" | "disk-only"

const extensionOf = (name: string): string => {
  const index = name.lastIndexOf(".")
  return index === -1 ? "" : name.slice(index + 1).toLowerCase()
}

/**
 * Куда идёт вложение, когда рантайм умеет сохранять файлы на диск. Модели
 * отдаём только то, что она реально читает (картинки, PDF, офисные документы
 * через извлечение текста); всё остальное агент откроет с диска по пути.
 */
export const classifyAttachmentDestination = (
  file: { readonly name: string; readonly type: string; readonly size: number },
): AttachmentDestination => {
  if (file.size > MODEL_ATTACHMENT_MAX_BYTES) return "disk-only"
  const mime = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  if (MODEL_MIMES.has(mime)) return "model-and-disk"
  if (MODEL_EXTENSIONS.has(extensionOf(file.name)) || isDocumentAttachmentFilename(file.name)) return "model-and-disk"
  return "disk-only"
}

// Управляющие символы в имени ломают путь и отображение; фильтр без regex,
// потому что eslint no-control-regex запрещает такие диапазоны.
const stripControlChars = (value: string): string =>
  Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code > 0x1f && code !== 0x7f
    })
    .join("")

/** Абсолютный путь `<home>/uploads/<имя>`; имя сводится к базовому, чтобы не выйти из папки. */
export const buildUploadPath = (homeDirectory: string, filename: string): string => {
  const home = homeDirectory.replace(/[\\/]+$/, "")
  const base = stripControlChars(filename.split(/[\\/]/).pop() ?? "").trim()
  const safeName = base === "" || base === "." || base === ".." ? "file" : base
  return `${home}/uploads/${safeName}`
}

export type SavedAttachment = { readonly path: string; readonly diskOnly: boolean }

/** Текст для агента; пузырь пользователя рисуется по метаданным context-части, а не по нему. */
export const buildSavedAttachmentsNotice = (saved: readonly SavedAttachment[]): string | null => {
  if (saved.length === 0) return null
  const lines = saved.map(({ path, diskOnly }) => diskOnly
    ? `- ${path} (только на диске, содержимое в сообщение не вложено — открой файл)`
    : `- ${path}`)
  return `Вложения сохранены на диск:\n${lines.join("\n")}`
}

/**
 * Та же заметка, но context-частью: модель читает прежний текст, а метаданные
 * дают пузырю пользователя показать файлы, которые не ушли file-частью.
 */
export const buildSavedAttachmentsContextPart = (saved: readonly SavedAttachment[]): ContextPart | null => {
  const notice = buildSavedAttachmentsNotice(saved)
  if (notice === null) return null
  const files = saved.slice(0, SAVED_FILES_LIMIT).map(({ path, diskOnly }) => ({
    path,
    name: path.split(/[\\/]/).pop() || path,
    diskOnly,
  }))
  return createContextPart({ kind: "saved-files", files }, notice)
}

export type UploadFailure =
  | { readonly kind: "file_too_large"; readonly limitBytes: number | undefined }
  | { readonly kind: "insufficient_storage" }
  | { readonly kind: "other"; readonly message: string }

export const describeUploadFailure = (error: unknown): UploadFailure => {
  if (isFilesystemError(error)) {
    if (error.reason === "file_too_large") return { kind: "file_too_large", limitBytes: error.limit }
    if (error.reason === "insufficient_storage") return { kind: "insufficient_storage" }
  }
  return { kind: "other", message: error instanceof Error ? error.message : String(error) }
}

export type DiskAttachmentEntry = {
  readonly diskFile?: File
  readonly diskOnly?: boolean
}

export type UploadAttachmentFn = (
  path: string,
  file: Blob,
  options: { onConflict: "rename" },
) => Promise<{ success: boolean; path: string }>

export type SaveAttachmentsResult =
  | { readonly ok: true; readonly saved: SavedAttachment[] }
  | { readonly ok: false; readonly file: File; readonly error: unknown }

// Повторная отправка после сбоя не должна плодить «name (2)» для уже сохранённых файлов.
const savedPathByFile = new WeakMap<File, string>()

export const saveAttachmentsToDisk = async (
  attachments: readonly DiskAttachmentEntry[],
  target: { readonly homeDirectory: string; readonly upload: UploadAttachmentFn },
): Promise<SaveAttachmentsResult> => {
  const saved: SavedAttachment[] = []
  for (const attachment of attachments) {
    const file = attachment.diskFile
    if (!file) continue
    const cached = savedPathByFile.get(file)
    if (cached) {
      saved.push({ path: cached, diskOnly: attachment.diskOnly === true })
      continue
    }
    try {
      const result = await target.upload(buildUploadPath(target.homeDirectory, file.name), file, { onConflict: "rename" })
      if (!result.success) return { ok: false, file, error: new Error("Upload was not accepted by the server") }
      savedPathByFile.set(file, result.path)
      saved.push({ path: result.path, diskOnly: attachment.diskOnly === true })
    } catch (error) {
      return { ok: false, file, error }
    }
  }
  return { ok: true, saved }
}
