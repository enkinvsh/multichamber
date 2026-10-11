import {
  OfficeParseError,
  attr,
  childElements,
  descendants,
  firstChild,
  readArchiveXml,
  type OfficeArchive,
} from './ooxml';

// Предел блоков верхнего уровня: длинные отчёты на тысячи страниц иначе
// превращаются в десятки тысяч DOM-узлов и подвешивают телефон.
export const DOCX_MAX_BLOCKS = 5000;

export type DocxRun =
  | { kind: 'text'; text: string; bold: boolean; italic: boolean; underline: boolean }
  | { kind: 'break' }
  | { kind: 'image' };

export type DocxTableCell = { colSpan: number; blocks: DocxBlock[] };

export type DocxBlock =
  | { kind: 'paragraph'; runs: DocxRun[] }
  /** level 0 — стиль Title, 1-3 — Heading1-3 (более глубокие сводятся к 3). */
  | { kind: 'heading'; level: 0 | 1 | 2 | 3; runs: DocxRun[] }
  | { kind: 'listItem'; level: number; runs: DocxRun[] }
  | { kind: 'table'; rows: DocxTableCell[][] };

export type DocxDocument = { blocks: DocxBlock[]; truncated: boolean };

type ParagraphStyle = { heading: 0 | 1 | 2 | 3 | null; listLevel: number | null };

// Атрибут w:val у булевых свойств: отсутствует или "1"/"true"/"on" — включено.
const isOn = (element: Element | null): boolean => {
  if (!element) return false;
  const value = attr(element, 'val');
  return value === null || !['0', 'false', 'off', 'none'].includes(value.toLowerCase());
};

const headingFromName = (name: string): 0 | 1 | 2 | 3 | null => {
  const normalized = name.toLowerCase().replace(/\s+/g, '');
  if (normalized === 'title') return 0;
  const match = normalized.match(/^heading([1-9])$/);
  if (!match) return null;
  return Math.min(Number(match[1]), 3) as 1 | 2 | 3;
};

const numPrLevel = (properties: Element | null): number | null => {
  const numPr = properties ? firstChild(properties, 'numPr') : null;
  if (!numPr) return null;
  // numId="0" в Word означает «нумерация снята».
  const numId = firstChild(numPr, 'numId');
  if (numId && attr(numId, 'val') === '0') return null;
  const ilvl = firstChild(numPr, 'ilvl');
  const level = Number(ilvl ? attr(ilvl, 'val') : 0);
  return Number.isInteger(level) && level >= 0 ? Math.min(level, 8) : 0;
};

/**
 * styleId → свойства абзаца. В локализованном Word id бывает «1» или «a3»,
 * поэтому заголовок узнаём по w:name («heading 1», «Title»), а не по id.
 */
const readStyles = (archive: OfficeArchive): Map<string, ParagraphStyle> => {
  const result = new Map<string, ParagraphStyle>();
  const document = readArchiveXml(archive, 'word/styles.xml');
  if (!document) return result;
  for (const style of descendants(document, 'style')) {
    if (attr(style, 'type') !== 'paragraph') continue;
    const id = attr(style, 'styleId');
    if (!id) continue;
    const nameElement = firstChild(style, 'name');
    const name = nameElement ? attr(nameElement, 'val') ?? '' : '';
    result.set(id, {
      heading: headingFromName(name) ?? headingFromName(id),
      listLevel: numPrLevel(firstChild(style, 'pPr')),
    });
  }
  return result;
};

type RunFormat = { bold: boolean; italic: boolean; underline: boolean };

const runFormat = (run: Element): RunFormat => {
  const properties = firstChild(run, 'rPr');
  if (!properties) return { bold: false, italic: false, underline: false };
  const underline = firstChild(properties, 'u');
  return {
    bold: isOn(firstChild(properties, 'b')),
    italic: isOn(firstChild(properties, 'i')),
    underline: Boolean(underline) && isOn(underline),
  };
};

const pushText = (runs: DocxRun[], text: string, format: RunFormat): void => {
  if (!text) return;
  const last = runs.at(-1);
  if (
    last?.kind === 'text'
    && last.bold === format.bold
    && last.italic === format.italic
    && last.underline === format.underline
  ) {
    last.text += text;
    return;
  }
  runs.push({ kind: 'text', text, ...format });
};

const collectRun = (run: Element, runs: DocxRun[]): void => {
  const format = runFormat(run);
  for (const child of childElements(run)) {
    switch (child.localName) {
      case 't':
        pushText(runs, child.textContent ?? '', format);
        break;
      case 'tab':
        pushText(runs, '\t', format);
        break;
      case 'noBreakHyphen':
        pushText(runs, '-', format);
        break;
      case 'br':
      case 'cr':
        runs.push({ kind: 'break' });
        break;
      case 'drawing':
      case 'pict':
      case 'object':
        runs.push({ kind: 'image' });
        break;
      default:
        break;
    }
  }
};

// Обёртки, внутри которых лежат обычные w:r: ссылки, правки (w:ins), поля, smartTag, sdt.
const RUN_CONTAINERS = new Set(['hyperlink', 'ins', 'smartTag', 'fldSimple', 'customXml', 'sdtContent', 'sdt']);

const collectRuns = (container: Element, runs: DocxRun[]): void => {
  for (const child of childElements(container)) {
    if (child.localName === 'r') collectRun(child, runs);
    else if (RUN_CONTAINERS.has(child.localName)) collectRuns(child, runs);
  }
};

const readParagraph = (paragraph: Element, styles: Map<string, ParagraphStyle>): DocxBlock => {
  const properties = firstChild(paragraph, 'pPr');
  const styleElement = properties ? firstChild(properties, 'pStyle') : null;
  const styleId = styleElement ? attr(styleElement, 'val') : null;
  const style = styleId ? styles.get(styleId) : undefined;
  const runs: DocxRun[] = [];
  collectRuns(paragraph, runs);

  const heading = style?.heading ?? (styleId ? headingFromName(styleId) : null);
  if (heading !== null) return { kind: 'heading', level: heading, runs };
  const listLevel = numPrLevel(properties) ?? style?.listLevel ?? null;
  if (listLevel !== null) return { kind: 'listItem', level: listLevel, runs };
  return { kind: 'paragraph', runs };
};

const readTable = (table: Element, styles: Map<string, ParagraphStyle>): DocxBlock => {
  const rows = childElements(table, 'tr').map((row) => childElements(row, 'tc').map((cell) => {
    const properties = firstChild(cell, 'tcPr');
    const gridSpan = properties ? firstChild(properties, 'gridSpan') : null;
    const span = Number(gridSpan ? attr(gridSpan, 'val') : 1);
    return {
      colSpan: Number.isInteger(span) && span > 1 ? Math.min(span, 63) : 1,
      blocks: readBlocks(cell, styles, Number.POSITIVE_INFINITY).blocks,
    };
  }));
  return { kind: 'table', rows };
};

function readBlocks(container: Element, styles: Map<string, ParagraphStyle>, limit: number): DocxDocument {
  const blocks: DocxBlock[] = [];
  let truncated = false;
  const visit = (parent: Element): void => {
    for (const child of childElements(parent)) {
      if (blocks.length >= limit) {
        truncated = true;
        return;
      }
      if (child.localName === 'p') blocks.push(readParagraph(child, styles));
      else if (child.localName === 'tbl') blocks.push(readTable(child, styles));
      else if (child.localName === 'sdt') {
        const content = firstChild(child, 'sdtContent');
        if (content) visit(content);
      } else if (child.localName === 'customXml') visit(child);
    }
  };
  visit(container);
  return { blocks, truncated };
}

export const parseDocx = (archive: OfficeArchive): DocxDocument => {
  const document = readArchiveXml(archive, 'word/document.xml');
  const body = document ? descendants(document, 'body')[0] : undefined;
  if (!body) throw new OfficeParseError('Document body is missing');
  return readBlocks(body, readStyles(archive), DOCX_MAX_BLOCKS);
};
