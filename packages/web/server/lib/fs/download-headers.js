// Типы, которые браузер исполняет при прямой навигации (скрипты в SVG/HTML/XML).
// PDF сюда не входит: встроенный просмотрщик Chrome не открывается под sandbox.
const ACTIVE_CONTENT_TYPES = new Set([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
]);

export const ACTIVE_CONTENT_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";

export const isActiveContentType = (mimeType) => ACTIVE_CONTENT_TYPES.has(mimeType);

// RFC 5987 attr-char не допускает ' ( ) *, а encodeURIComponent их не кодирует.
const encodeRfc5987 = (value) => encodeURIComponent(value)
  .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

// Имя файла на Linux может содержать перевод строки и кавычки: в заголовок они
// попасть не должны, иначе setHeader бросит ERR_INVALID_CHAR или заголовок сломается.
const asciiFallbackName = (fileName) => {
  // trimStart: от «отчёт продаж.xlsx» без кириллицы остаётся « .xlsx».
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '_').trimStart();
  // От «отчёт.xlsx» остаётся «.xlsx»: старые клиенты сохранили бы скрытый файл.
  if (ascii === '' || (ascii.startsWith('.') && !fileName.startsWith('.'))) {
    return `download${ascii}`;
  }
  return ascii;
};

export const attachmentDisposition = (fileName) => (
  `attachment; filename="${asciiFallbackName(fileName)}"; filename*=UTF-8''${encodeRfc5987(fileName)}`
);
