import {
  OfficeParseError,
  attr,
  childElements,
  descendants,
  firstChild,
  readArchiveXml,
  readRelationships,
  type OfficeArchive,
} from './ooxml';

export const XLSX_MAX_ROWS = 1000;
export const XLSX_MAX_COLUMNS = 50;

export type XlsxCell =
  | { kind: 'text'; text: string }
  | { kind: 'number'; text: string }
  | { kind: 'date'; text: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'error'; text: string };

export type XlsxSheet = {
  name: string;
  /** Плотная сетка от A1: rows[r][c], null для пустой ячейки. */
  rows: (XlsxCell | null)[][];
  columnCount: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
};

export type XlsxWorkbook = { sheets: XlsxSheet[] };

type NumberFormatKind = 'general' | 'date' | 'time' | 'datetime' | 'percent';

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22]);
const BUILTIN_TIME_FORMATS = new Set([18, 19, 20, 21, 45, 46, 47]);
const BUILTIN_PERCENT_FORMATS = new Set([9, 10]);

/** Убирает из кода формата литералы: "текст", [цвет/локаль], \x, _x, *x — в них d/m/y/h не значат дату. */
const stripFormatLiterals = (code: string): string => code
  .replace(/"[^"]*"/g, '')
  .replace(/\[[^\]]*\]/g, '')
  .replace(/\\./g, '')
  .replace(/[_*]./g, '');

export const classifyNumberFormat = (numFmtId: number, formatCode: string | undefined): NumberFormatKind => {
  if (BUILTIN_DATE_FORMATS.has(numFmtId)) return numFmtId === 22 ? 'datetime' : 'date';
  if (BUILTIN_TIME_FORMATS.has(numFmtId)) return 'time';
  if (BUILTIN_PERCENT_FORMATS.has(numFmtId)) return 'percent';
  if (!formatCode) return 'general';
  // Для разных знаков числа формат делится «;» — дату определяет первая секция.
  const code = stripFormatLiterals(formatCode.split(';')[0] ?? '');
  const hasDate = /[dy]/i.test(code) || (/m/i.test(code) && !/[hs]/i.test(code));
  const hasTime = /[hs]/i.test(code);
  if (hasDate && hasTime) return 'datetime';
  if (hasDate) return 'date';
  if (hasTime) return 'time';
  if (code.includes('%')) return 'percent';
  return 'general';
};

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');

// Серийная дата Excel: 25569 — это 1970-01-01 в системе 1900 (с учётом фиктивного 29.02.1900).
// В книгах с date1904 отсчёт сдвинут на 1462 дня.
export const formatExcelDate = (serial: number, kind: 'date' | 'time' | 'datetime', date1904: boolean): string => {
  const days = date1904 ? serial + 1462 : serial;
  const totalSeconds = Math.round((days - 25569) * 86400);
  const date = new Date(totalSeconds * 1000);
  if (Number.isNaN(date.getTime())) return String(serial);
  const datePart = `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCFullYear(), 4)}`;
  const seconds = date.getUTCSeconds();
  const timePart = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}${seconds ? `:${pad(seconds)}` : ''}`;
  if (kind === 'time') return serial < 1 ? timePart : `${datePart} ${timePart}`;
  const hasTime = Math.abs(totalSeconds % 86400) !== 0;
  return kind === 'datetime' || hasTime ? `${datePart} ${timePart}` : datePart;
};

// Убираем хвосты двоичной арифметики (0.30000000000000004), как это делает Excel при показе.
const formatNumber = (value: number): string => String(Number(value.toPrecision(15)));

export const columnName = (index: number): string => {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
};

const columnIndex = (letters: string): number => {
  let result = 0;
  for (const character of letters.toUpperCase()) result = result * 26 + character.charCodeAt(0) - 64;
  return result - 1;
};

/** Текст <si>/<is>: прямой <t> или <r><t>; фонетические подсказки <rPh> пропускаем. */
const richText = (element: Element): string => {
  let text = '';
  for (const child of childElements(element)) {
    if (child.localName === 't') text += child.textContent ?? '';
    else if (child.localName === 'r') {
      const t = firstChild(child, 't');
      if (t) text += t.textContent ?? '';
    }
  }
  return text;
};

const readSharedStrings = (archive: OfficeArchive, path: string | undefined): string[] => {
  const document = path ? readArchiveXml(archive, path) : null;
  if (!document) return [];
  return childElements(document.documentElement, 'si').map(richText);
};

const readStyleFormats = (archive: OfficeArchive, path: string | undefined): NumberFormatKind[] => {
  const document = path ? readArchiveXml(archive, path) : null;
  if (!document) return [];
  const customFormats = new Map<number, string>();
  for (const numFmt of descendants(document, 'numFmt')) {
    const id = Number(attr(numFmt, 'numFmtId'));
    const code = attr(numFmt, 'formatCode');
    if (Number.isFinite(id) && code !== null) customFormats.set(id, code);
  }
  const cellXfs = firstChild(document.documentElement, 'cellXfs');
  if (!cellXfs) return [];
  return childElements(cellXfs, 'xf').map((xf) => {
    const id = Number(attr(xf, 'numFmtId') ?? 0);
    return classifyNumberFormat(id, customFormats.get(id));
  });
};

type SheetContext = {
  sharedStrings: string[];
  formats: NumberFormatKind[];
  date1904: boolean;
};

const readCell = (cell: Element, context: SheetContext): XlsxCell | null => {
  const type = attr(cell, 't') ?? 'n';
  if (type === 'inlineStr') {
    const inline = firstChild(cell, 'is');
    const text = inline ? richText(inline) : '';
    return text ? { kind: 'text', text } : null;
  }
  // У формулы показываем закэшированное значение <v>; без него ячейка пустая.
  const raw = firstChild(cell, 'v')?.textContent ?? '';
  if (raw === '') return null;
  switch (type) {
    case 's': {
      const text = context.sharedStrings[Number(raw)] ?? '';
      return text ? { kind: 'text', text } : null;
    }
    case 'str':
      return { kind: 'text', text: raw };
    case 'b':
      return { kind: 'boolean', value: raw === '1' || raw.toLowerCase() === 'true' };
    case 'e':
      return { kind: 'error', text: raw };
    case 'd':
      return { kind: 'date', text: raw };
    default: {
      const value = Number(raw);
      if (!Number.isFinite(value)) return { kind: 'text', text: raw };
      const format = context.formats[Number(attr(cell, 's') ?? 0)] ?? 'general';
      if (format === 'date' || format === 'time' || format === 'datetime') {
        return { kind: 'date', text: formatExcelDate(value, format, context.date1904) };
      }
      if (format === 'percent') return { kind: 'number', text: `${formatNumber(value * 100)}%` };
      return { kind: 'number', text: formatNumber(value) };
    }
  }
};

const readSheet = (archive: OfficeArchive, path: string, name: string, context: SheetContext): XlsxSheet => {
  const document = readArchiveXml(archive, path);
  const cells = new Map<number, Map<number, XlsxCell>>();
  let maxRow = -1;
  let maxColumn = -1;

  const sheetData = document ? descendants(document, 'sheetData')[0] : undefined;
  let nextRow = 0;
  for (const row of sheetData ? childElements(sheetData, 'row') : []) {
    const rowAttr = Number(attr(row, 'r'));
    const rowIndex = Number.isInteger(rowAttr) && rowAttr > 0 ? rowAttr - 1 : nextRow;
    nextRow = rowIndex + 1;
    let nextColumn = 0;
    for (const cell of childElements(row, 'c')) {
      const reference = attr(cell, 'r')?.match(/^([A-Za-z]{1,3})\d*$/);
      const column = reference ? columnIndex(reference[1]) : nextColumn;
      nextColumn = column + 1;
      const value = readCell(cell, context);
      if (!value) continue;
      maxRow = Math.max(maxRow, rowIndex);
      maxColumn = Math.max(maxColumn, column);
      if (rowIndex >= XLSX_MAX_ROWS || column >= XLSX_MAX_COLUMNS) continue;
      let rowCells = cells.get(rowIndex);
      if (!rowCells) {
        rowCells = new Map();
        cells.set(rowIndex, rowCells);
      }
      rowCells.set(column, value);
    }
  }

  const rowCount = Math.min(maxRow + 1, XLSX_MAX_ROWS);
  const columnCount = Math.min(maxColumn + 1, XLSX_MAX_COLUMNS);
  const rows = Array.from({ length: rowCount }, (_, rowIndex) => {
    const rowCells = cells.get(rowIndex);
    return Array.from({ length: columnCount }, (__, column) => rowCells?.get(column) ?? null);
  });
  return {
    name,
    rows,
    columnCount,
    truncatedRows: maxRow + 1 > XLSX_MAX_ROWS,
    truncatedColumns: maxColumn + 1 > XLSX_MAX_COLUMNS,
  };
};

export const parseXlsx = (archive: OfficeArchive): XlsxWorkbook => {
  const workbookPath = 'xl/workbook.xml';
  const workbook = readArchiveXml(archive, workbookPath);
  if (!workbook) throw new OfficeParseError('Workbook part is missing');
  const relationships = readRelationships(archive, workbookPath);
  const relationshipTargets = new Map<string, string>();
  // sharedStrings/styles ищем через связи книги: путь не обязан быть стандартным.
  for (const path of relationships.values()) {
    if (/sharedStrings[^/]*\.xml$/i.test(path)) relationshipTargets.set('sharedStrings', path);
    if (/styles[^/]*\.xml$/i.test(path)) relationshipTargets.set('styles', path);
  }
  const workbookPr = descendants(workbook, 'workbookPr')[0];
  const date1904Value = workbookPr ? attr(workbookPr, 'date1904') : null;
  const context: SheetContext = {
    sharedStrings: readSharedStrings(archive, relationshipTargets.get('sharedStrings') ?? 'xl/sharedStrings.xml'),
    formats: readStyleFormats(archive, relationshipTargets.get('styles') ?? 'xl/styles.xml'),
    date1904: date1904Value === '1' || date1904Value === 'true',
  };

  const sheetElements = descendants(workbook, 'sheet');
  const visible = sheetElements.filter((sheet) => !attr(sheet, 'state') || attr(sheet, 'state') === 'visible');
  // Скрытые листы пользователь в Excel не видит; если скрыто всё, показываем всё.
  const shown = visible.length > 0 ? visible : sheetElements;
  const sheets: XlsxSheet[] = [];
  for (const sheet of shown) {
    const id = attr(sheet, 'id');
    const path = id ? relationships.get(id) : undefined;
    if (!path || !archive[path]) continue;
    sheets.push(readSheet(archive, path, attr(sheet, 'name') ?? `Sheet${sheets.length + 1}`, context));
  }
  if (sheets.length === 0) throw new OfficeParseError('Workbook has no readable sheets');
  return { sheets };
};
