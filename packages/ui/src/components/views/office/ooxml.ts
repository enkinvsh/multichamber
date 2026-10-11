import { unzip, unzipSync, type UnzipFileInfo, type Unzipped } from 'fflate';

import { MAX_OFFICE_PREVIEW_BYTES } from './officeFileKind';

// Лимиты повторяют разбор вложений в чате (sync/document-attachments.ts): защита
// от zip-бомб и гигантских XML, которые повесят вкладку на телефоне.
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_XML_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5_000;

export type OfficeArchive = Unzipped;

export class OfficeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeParseError';
  }
}

const isXmlEntry = (name: string): boolean => /\.(?:xml|rels)$/i.test(name);

const createEntryValidator = () => {
  let entries = 0;
  let uncompressedBytes = 0;
  return (info: UnzipFileInfo): void => {
    entries += 1;
    if (entries > MAX_ARCHIVE_ENTRIES) throw new OfficeParseError('Archive contains too many files');
    if (!isXmlEntry(info.name)) return;
    uncompressedBytes += info.originalSize;
    if (info.originalSize > MAX_XML_ENTRY_BYTES) throw new OfficeParseError('Archive contains an oversized XML file');
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw new OfficeParseError('Archive expands beyond the safety limit');
  };
};

const validateExtracted = (archive: Unzipped): void => {
  let total = 0;
  for (const bytes of Object.values(archive)) {
    total += bytes.byteLength;
    // originalSize в заголовке zip можно подделать, поэтому проверяем и фактический размер.
    if (bytes.byteLength > MAX_XML_ENTRY_BYTES) throw new OfficeParseError('Archive contains an oversized XML file');
    if (total > MAX_UNCOMPRESSED_BYTES) throw new OfficeParseError('Archive expands beyond the safety limit');
  }
};

/** Распаковывает только XML-части OOXML-пакета: картинки и бинарные вложения превью не нужны. */
export const unzipOfficeArchive = async (data: Uint8Array): Promise<OfficeArchive> => {
  if (data.byteLength > MAX_OFFICE_PREVIEW_BYTES) throw new OfficeParseError('File is too large to preview');
  const validate = createEntryValidator();
  // Проход только по центральному каталогу: фильтр возвращает false, распаковки нет.
  unzipSync(data, { filter: (info) => {
    validate(info);
    return false;
  } });

  const filter = (info: UnzipFileInfo) => isXmlEntry(info.name);
  // В Bun воркеры fflate ненадёжны (см. document-attachments.ts), в браузере
  // асинхронная распаковка уходит в воркер и не блокирует интерфейс.
  const archive = 'Bun' in globalThis
    ? unzipSync(data, { filter })
    : await new Promise<Unzipped>((resolve, reject) => {
      unzip(data, { filter }, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  validateExtracted(archive);
  return archive;
};

const textDecoder = new TextDecoder();

export const readArchiveText = (archive: OfficeArchive, path: string): string | null => {
  const bytes = archive[path];
  return bytes ? textDecoder.decode(bytes) : null;
};

export const parseXml = (source: string): Document => {
  // В OOXML DOCTYPE не бывает; отказ от него закрывает атаки через сущности.
  if (/<!DOCTYPE/i.test(source)) throw new OfficeParseError('Unexpected DOCTYPE in document XML');
  const document = new DOMParser().parseFromString(source, 'application/xml');
  if (document.getElementsByTagName('parsererror').length > 0) {
    throw new OfficeParseError('Malformed document XML');
  }
  return document;
};

export const readArchiveXml = (archive: OfficeArchive, path: string): Document | null => {
  const source = readArchiveText(archive, path);
  return source === null ? null : parseXml(source);
};

// Сравниваем по localName: префиксы (w:, x:, без префикса) в разных генераторах
// и в Strict OOXML отличаются, а getAttributeNS в happy-dom не работает.
export const childElements = (parent: Element, localName?: string): Element[] => {
  const result: Element[] = [];
  for (const child of Array.from(parent.children)) {
    if (!localName || child.localName === localName) result.push(child);
  }
  return result;
};

export const firstChild = (parent: Element, localName: string): Element | null => {
  for (const child of Array.from(parent.children)) {
    if (child.localName === localName) return child;
  }
  return null;
};

export const descendants = (root: Document | Element, localName: string): Element[] => {
  return Array.from(root.getElementsByTagName('*')).filter((element) => element.localName === localName);
};

export const attr = (element: Element, localName: string): string | null => {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.localName || attribute.name;
    if (name === localName || attribute.name.endsWith(`:${localName}`)) return attribute.value;
  }
  return null;
};

const normalizeArchivePath = (path: string): string | null => {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
};

export const resolveArchivePath = (sourcePath: string, target: string): string | null => {
  if (target.startsWith('/')) return normalizeArchivePath(target.slice(1));
  const directory = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1) : '';
  return normalizeArchivePath(`${directory}${target}`);
};

const relationshipsPath = (sourcePath: string): string => {
  const index = sourcePath.lastIndexOf('/');
  return `${index === -1 ? '' : sourcePath.slice(0, index + 1)}_rels/${sourcePath.slice(index + 1)}.rels`;
};

/** Карта r:id → путь внутри архива для части `sourcePath`. */
export const readRelationships = (archive: OfficeArchive, sourcePath: string): Map<string, string> => {
  const result = new Map<string, string>();
  const document = readArchiveXml(archive, relationshipsPath(sourcePath));
  if (!document) return result;
  for (const relationship of descendants(document, 'Relationship')) {
    const id = attr(relationship, 'Id');
    const target = attr(relationship, 'Target');
    if (!id || !target || attr(relationship, 'TargetMode') === 'External') continue;
    const resolved = resolveArchivePath(sourcePath, target);
    if (resolved) result.set(id, resolved);
  }
  return result;
};
