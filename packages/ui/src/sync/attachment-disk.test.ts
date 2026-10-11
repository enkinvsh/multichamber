import { describe, expect, test } from "bun:test"
import { FilesystemError } from "@/lib/api/files-errors"
import {
  MODEL_ATTACHMENT_MAX_BYTES,
  buildSavedAttachmentsNotice,
  buildUploadPath,
  classifyAttachmentDestination,
  describeUploadFailure,
  saveAttachmentsToDisk,
  type UploadAttachmentFn,
} from "./attachment-disk"

const MB = 1024 * 1024

describe("classifyAttachmentDestination", () => {
  test("sends images, pdf and office documents to the model when within 20 MB", () => {
    expect(classifyAttachmentDestination({ name: "photo.jpg", type: "image/jpeg", size: MB })).toBe("model-and-disk")
    expect(classifyAttachmentDestination({ name: "scan", type: "application/pdf", size: MB })).toBe("model-and-disk")
    expect(classifyAttachmentDestination({ name: "IMG.HEIC", type: "", size: MB })).toBe("model-and-disk")
    expect(classifyAttachmentDestination({ name: "report.xlsx", type: "", size: MB })).toBe("model-and-disk")
  })

  test("keeps the 20 MB boundary inclusive for the model", () => {
    expect(classifyAttachmentDestination({ name: "a.png", type: "image/png", size: MODEL_ATTACHMENT_MAX_BYTES })).toBe("model-and-disk")
    expect(classifyAttachmentDestination({ name: "a.png", type: "image/png", size: MODEL_ATTACHMENT_MAX_BYTES + 1 })).toBe("disk-only")
  })

  test("routes every other type to disk only", () => {
    for (const [name, type] of [
      ["archive.zip", "application/zip"],
      ["data.csv", "text/csv"],
      ["notes.txt", "text/plain"],
      ["song.mp3", "audio/mpeg"],
      ["clip.mp4", "video/mp4"],
      ["logo.svg", "image/svg+xml"],
      ["blob", ""],
    ] as const) {
      expect(classifyAttachmentDestination({ name, type, size: 10 })).toBe("disk-only")
    }
  })
})

describe("buildUploadPath", () => {
  test("joins home, uploads and the base name", () => {
    expect(buildUploadPath("/home/dev", "report (2).xlsx")).toBe("/home/dev/uploads/report (2).xlsx")
    expect(buildUploadPath("/home/dev/", "a.txt")).toBe("/home/dev/uploads/a.txt")
  })

  test("cannot escape the uploads folder through the name", () => {
    expect(buildUploadPath("/home/dev", "../../etc/passwd")).toBe("/home/dev/uploads/passwd")
    expect(buildUploadPath("/home/dev", "..")).toBe("/home/dev/uploads/file")
    expect(buildUploadPath("/home/dev", "dir\\evil.txt")).toBe("/home/dev/uploads/evil.txt")
  })
})

describe("buildSavedAttachmentsNotice", () => {
  test("lists saved paths and flags disk-only ones", () => {
    const notice = buildSavedAttachmentsNotice([
      { path: "/home/dev/uploads/a.png", diskOnly: false },
      { path: "/home/dev/uploads/b.zip", diskOnly: true },
    ])
    expect(notice?.split("\n")).toHaveLength(3)
    expect(notice).toContain("- /home/dev/uploads/a.png\n")
    expect(notice).toContain("- /home/dev/uploads/b.zip (")
  })

  test("returns null when nothing was saved", () => {
    expect(buildSavedAttachmentsNotice([])).toBeNull()
  })
})

describe("describeUploadFailure", () => {
  test("maps server reasons", () => {
    expect(describeUploadFailure(new FilesystemError("x", { reason: "file_too_large", limit: 100 * MB })))
      .toEqual({ kind: "file_too_large", limitBytes: 100 * MB })
    expect(describeUploadFailure(new FilesystemError("x", { reason: "insufficient_storage" })))
      .toEqual({ kind: "insufficient_storage" })
    expect(describeUploadFailure(new Error("boom"))).toEqual({ kind: "other", message: "boom" })
  })
})

describe("saveAttachmentsToDisk", () => {
  test("uploads each disk file once with rename-on-conflict and reuses the result on retry", async () => {
    const calls: string[] = []
    const upload: UploadAttachmentFn = async (path, _file, options) => {
      calls.push(`${path}|${options.onConflict}`)
      return { success: true, path: path.replace("a.zip", "a (2).zip") }
    }
    const file = new File(["x"], "a.zip")
    const entries = [{ diskFile: file, diskOnly: true }, {}]

    const first = await saveAttachmentsToDisk(entries, { homeDirectory: "/home/u", upload })
    const second = await saveAttachmentsToDisk(entries, { homeDirectory: "/home/u", upload })

    expect(first).toEqual({ ok: true, saved: [{ path: "/home/u/uploads/a (2).zip", diskOnly: true }] })
    expect(second).toEqual(first)
    expect(calls).toEqual(["/home/u/uploads/a.zip|rename"])
  })

  test("stops at the first failure and reports the file", async () => {
    const error = new FilesystemError("too big", { reason: "file_too_large" })
    const upload: UploadAttachmentFn = async () => { throw error }
    const file = new File(["x"], "big.mp4")

    const result = await saveAttachmentsToDisk([{ diskFile: file, diskOnly: true }], { homeDirectory: "/h", upload })

    expect(result).toEqual({ ok: false, file, error })
  })
})
