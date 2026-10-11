import { isAbsoluteFilePath, normalizeFilePath } from '@/lib/path-utils';

export type ParsedFileReference = {
    path: string;
    line?: number;
    column?: number;
    endLine?: number;
};

const KNOWN_FILE_BASENAMES = new Set([
    'dockerfile',
    'makefile',
    'readme',
    'license',
    '.env',
    '.gitignore',
    '.npmrc',
]);
const KNOWN_BASENAME_PATTERN = Array.from(KNOWN_FILE_BASENAMES)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

export const normalizeReferencePath = (value: string): string => normalizeFilePath(value);

export const isAbsoluteReferencePath = (value: string): boolean => isAbsoluteFilePath(value);

export const localPathFromFileUrl = (value: string): string | null => {
    let parsed: URL;
    try {
        parsed = new URL(value.trim());
    } catch {
        return null;
    }

    if (parsed.protocol !== 'file:' || (parsed.hostname && parsed.hostname !== 'localhost')) {
        return null;
    }

    try {
        const decodedPath = decodeURIComponent(parsed.pathname);
        if (/^\/[A-Za-z]:\//.test(decodedPath)) {
            return decodedPath.slice(1);
        }
        return decodedPath.startsWith('/') ? decodedPath : null;
    } catch {
        return null;
    }
};

const trimPathCandidate = (value: string): string => {
    let next = (value || '').trim();
    if (!next) {
        return '';
    }

    if ((next.startsWith('`') && next.endsWith('`')) || (next.startsWith('"') && next.endsWith('"')) || (next.startsWith("'") && next.endsWith("'"))) {
        next = next.slice(1, -1).trim();
    }

    next = next.replace(/[.,;!?]+$/g, '');

    if (next.endsWith(')') && !next.includes('(')) {
        next = next.slice(0, -1);
    }
    if (next.endsWith(']') && !next.includes('[')) {
        next = next.slice(0, -1);
    }

    return next;
};

const stripTrailingReference = (value: string): string => {
    let next = trimPathCandidate(value);
    if (!next) {
        return '';
    }

    const semicolonIndex = next.indexOf(';');
    if (semicolonIndex >= 0) {
        next = next.slice(0, semicolonIndex);
    }

    next = next.replace(/#.*$/, '');

    const extensionSuffixMatch = next.match(/^(.*\.[A-Za-z0-9_-]{1,16}):.*$/);
    if (extensionSuffixMatch) {
        next = extensionSuffixMatch[1] ?? next;
    }

    const basenameSuffixMatch = KNOWN_BASENAME_PATTERN.length > 0
        ? next.match(new RegExp(`^(.*(?:/|^)(${KNOWN_BASENAME_PATTERN})):.*$`, 'i'))
        : null;
    if (basenameSuffixMatch) {
        next = basenameSuffixMatch[1] ?? next;
    }

    return trimPathCandidate(next);
};

export const parseFileReference = (value: string): ParsedFileReference | null => {
    const trimmed = trimPathCandidate(value);
    if (!trimmed) {
        return null;
    }

    const semicolonIndex = trimmed.indexOf(';');
    const withoutSemicolonSuffix = semicolonIndex >= 0
        ? trimPathCandidate(trimmed.slice(0, semicolonIndex))
        : trimmed;
    if (!withoutSemicolonSuffix) {
        return null;
    }

    // Range form: `path:start-end`. Tried before the colon form so a suffix
    // like `:10-20` is consumed as a range rather than truncated to a line
    // number. Range and col (`:line:col`) are mutually exclusive.
    const rangeMatch = withoutSemicolonSuffix.match(/^(.*?):(\d+)-(\d+)$/);
    if (rangeMatch) {
        const path = stripTrailingReference(rangeMatch[1] ?? '');
        const line = Number.parseInt(rangeMatch[2] ?? '', 10);
        const endLine = Number.parseInt(rangeMatch[3] ?? '', 10);
        if (!path || !Number.isFinite(line) || !Number.isFinite(endLine) || endLine < line) {
            return null;
        }

        return { path, line, endLine };
    }

    const hashMatch = withoutSemicolonSuffix.match(/^(.*)#L(\d+)(?:C(\d+))?$/i);
    if (hashMatch) {
        const path = stripTrailingReference(hashMatch[1] ?? '');
        const line = Number.parseInt(hashMatch[2] ?? '', 10);
        const column = hashMatch[3] ? Number.parseInt(hashMatch[3], 10) : undefined;
        if (!path || !Number.isFinite(line)) {
            return null;
        }

        return {
            path,
            line,
            column: Number.isFinite(column ?? Number.NaN) ? column : undefined,
        };
    }

    const colonMatch = withoutSemicolonSuffix.match(/^(.*?):(\d+)(?::(\d+))?$/);
    if (colonMatch) {
        const path = stripTrailingReference(colonMatch[1] ?? '');
        const line = Number.parseInt(colonMatch[2] ?? '', 10);
        const column = colonMatch[3] ? Number.parseInt(colonMatch[3], 10) : undefined;
        if (!path || !Number.isFinite(line)) {
            return null;
        }

        return {
            path,
            line,
            column: Number.isFinite(column ?? Number.NaN) ? column : undefined,
        };
    }

    const pathOnly = stripTrailingReference(withoutSemicolonSuffix);
    if (!pathOnly) {
        return null;
    }

    return { path: pathOnly };
};

/**
 * Раскрывает `~` в домашнюю папку. Без известной домашней папки возвращает null:
 * иначе `~/x` разрешился бы относительно проекта в несуществующий `<проект>/~/x`.
 */
export const expandHomeReferencePath = (path: string, homeDirectory: string | null | undefined): string | null => {
    if (path !== '~' && !path.startsWith('~/')) {
        return path;
    }
    const home = (homeDirectory ?? '').trim().replace(/\/+$/, '');
    if (!home) {
        return null;
    }
    return path === '~' ? home : `${home}${path.slice(1)}`;
};

export const fileUrlToReferenceCandidate = (value: string): string => {
    const trimmed = value.trim();
    if (!/^file:\/\//i.test(trimmed)) {
        return value;
    }
    return localPathFromFileUrl(trimmed) ?? value;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Путь в обычном тексте кончается на пробеле или кавычке/скобке; хвостовую
// пунктуацию снимает trimPathCandidate, как и для остальных кандидатов.
const TEXT_PATH_BODY = '[^\\s<>"\'`«»()\\[\\]{}]+';

/**
 * Пути в обычном тексте сообщения, которые стоит проверить: `~/…`, `<home>/…`
 * и `file:///…`. Только с границы слова — так `https://host/home/dev/x` и прочие
 * URL не дают ложных совпадений.
 */
export const findHomePathTokens = (
    text: string,
    homeDirectory: string | null | undefined,
): Array<{ start: number; end: number; raw: string }> => {
    const home = (homeDirectory ?? '').trim().replace(/\/+$/, '');
    const prefixes = ['~/', 'file:///'];
    if (home && home !== '/') {
        prefixes.push(`${home}/`);
    }
    const pattern = new RegExp(
        `(^|[\\s(\\[{"'«])((?:${prefixes.map(escapeRegExp).join('|')})${TEXT_PATH_BODY})`,
        'g',
    );
    const tokens: Array<{ start: number; end: number; raw: string }> = [];
    let match = pattern.exec(text);
    while (match) {
        const lead = match[1] ?? '';
        const candidate = match[2] ?? '';
        const raw = trimPathCandidate(candidate);
        if (raw && !raw.endsWith('/')) {
            const start = match.index + lead.length;
            tokens.push({ start, end: start + raw.length, raw });
        }
        match = pattern.exec(text);
    }
    return tokens;
};

// Matches `path[:line[:col]]` or `path:start-end` inside shell/grep-style
// output. Requires a file extension (1-8 alphanumerics) so plain words don't
// qualify; the path itself must contain at least one extension-bearing
// segment. The line suffix is either `:N`, `:N:M`, or `:N-M` (range); col and
// range are mutually exclusive.
//
// Known limitation: backslash-separated Windows paths (e.g.
// `C:\Users\test\file.ts:12`) are not matched because the path character class
// does not include `\`. Compiler output inside fenced code blocks predominantly
// uses forward slashes, so this is a niche gap. The inline-code pipeline is not
// affected — it reads full text content rather than matching with a regex.
export const BLOCK_PATH_TOKEN_RE = /(?:[A-Za-z]:[\\/])?[\w.\-/@+]*[\w\-/@+]\.[A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?(?::\d+)?)?/g;
