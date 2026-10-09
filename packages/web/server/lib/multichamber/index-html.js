/**
 * Serve-time rewrite of the built `index.html` for an operator brand.
 *
 * Pure string work on the anchors upstream ships in `packages/web/index.html`.
 * A missing anchor leaves that part of the page stock instead of failing the
 * request; `index-html.test.js` renders the real file so upstream drift shows
 * up as a failing test.
 */

/** Element the UI reads the brand from (`packages/ui/src/lib/multichamber/brand.ts`). */
export const MULTICHAMBER_BRAND_ELEMENT_ID = 'multichamber-brand';

const HTML_ENTITIES = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
]);

/** @param {string} value */
const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => HTML_ENTITIES.get(char) ?? char);

/**
 * JSON that is safe inside an inline `<script>` element and as a JavaScript
 * literal: no `</script>`, comment openers or JavaScript-only line separators
 * survive.
 * @param {Parameters<typeof JSON.stringify>[0]} value
 */
export const serializeInlineJson = (value) => JSON.stringify(value)
  .replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * @typedef {{ background: string, foreground: string }} SplashColors
 * @typedef {'180x180' | '167x167' | '152x152'} AppleTouchSize
 * @typedef {{
 *   name: string | null,
 *   shortName: string | null,
 *   icons: {
 *     svg: string | null,
 *     ico: string | null,
 *     appleTouch: Record<AppleTouchSize, string | null>,
 *   },
 *   logoUrl: string | null,
 *   splash: { light: SplashColors | null, dark: SplashColors | null },
 *   themeColor: string | null,
 *   clientConfig: Parameters<typeof JSON.stringify>[0],
 * }} BrandedIndexOptions
 * Icon and logo values are URLs of brand files that exist, or null to keep the
 * stock file. Colours must be validated by the caller.
 */

/**
 * Replaces through a function so `$` sequences in brand values stay literal.
 * @param {string} html
 * @param {RegExp} pattern
 * @param {(match: string) => string} replace
 */
const replaceWith = (html, pattern, replace) => html.replace(pattern, (match) => replace(match));

/** @param {string} html @param {BrandedIndexOptions} options */
const applyName = (html, { name, shortName }) => {
  if (!name) return html;
  const escaped = escapeHtml(name);
  let next = replaceWith(html, /const defaultAppName = '[^'\n]*';/, () => `const defaultAppName = ${serializeInlineJson(name)};`);
  next = replaceWith(next, /const defaultShortName = '[^'\n]*';/, () => `const defaultShortName = ${serializeInlineJson(shortName ?? name)};`);
  next = replaceWith(next, /<title>[^<]*<\/title>/, () => `<title>${escaped}</title>`);
  next = replaceWith(next, /<meta\s+name="apple-mobile-web-app-title"\s+content="[^"]*"\s*\/?>/g, () => `<meta name="apple-mobile-web-app-title" content="${escaped}" />`);
  return replaceWith(next, /<meta\s+name="application-name"\s+content="[^"]*"\s*\/?>/g, () => `<meta name="application-name" content="${escaped}" />`);
};

const STOCK_PNG_FAVICON = /\n?[ \t]*<link\s+rel="icon"\s+type="image\/png"\s+href="\/favicon-(?:32|16)\.png"[^>]*>/g;
const STOCK_SVG_FAVICON = /<link\s+rel="icon"\s+type="image\/svg\+xml"\s+href="\/favicon\.svg"\s*\/?>/;
const STOCK_MASK_ICON = /\n?[ \t]*<link\s+rel="mask-icon"\s+href="\/favicon\.svg"[^>]*>/;

/** @param {string} html @param {BrandedIndexOptions} options */
const applyIcons = (html, { icons }) => {
  let next = html;
  if (icons.svg || icons.ico) {
    // Stock PNG favicons and the stock pinned-tab mask would compete with the brand icon.
    next = replaceWith(next, STOCK_PNG_FAVICON, () => '');
    next = replaceWith(next, STOCK_MASK_ICON, () => '');
    const links = [
      // `sizes` keeps browsers that understand SVG on the SVG icon.
      icons.ico ? `<link rel="icon" href="${escapeHtml(icons.ico)}" sizes="32x32" />` : null,
      icons.svg ? `<link rel="icon" type="image/svg+xml" href="${escapeHtml(icons.svg)}" />` : null,
    ].filter((link) => link !== null);
    next = replaceWith(next, STOCK_SVG_FAVICON, () => links.join('\n    '));
  }

  const appleTouch = Object.entries(icons.appleTouch);
  if (appleTouch.some(([, url]) => url !== null)) {
    for (const [size, url] of appleTouch) {
      const pattern = new RegExp(`\\n?[ \\t]*<link\\s+rel="apple-touch-icon"\\s+sizes="${size}"[^>]*>`);
      // Without a brand file for this size iOS picks the nearest brand size instead of the stock mark.
      next = replaceWith(next, pattern, (match) => (url
        ? match.replace(/href="[^"]*"/, () => `href="${escapeHtml(url)}"`)
        : ''));
    }
  }
  return next;
};

/** @param {string} html @param {BrandedIndexOptions} options */
const applyThemeColor = (html, { themeColor }) => {
  if (!themeColor) return html;
  return replaceWith(html, /<meta\s+name="theme-color"\s+content="[^"]*"/g, () => `<meta name="theme-color" content="${escapeHtml(themeColor)}"`);
};

/** @param {string} html @param {BrandedIndexOptions} options */
const applyLoadingMark = (html, { name, logoUrl }) => {
  if (!logoUrl) return html;
  const url = escapeHtml(logoUrl);
  const label = name ? `role="img" aria-label="${escapeHtml(name)}"` : 'aria-hidden="true"';
  // A mask paints the single-colour logo in the splash foreground; an <img> would ignore currentColor.
  const mark = `<div id="multichamber-loading-logo" ${label} style="width: 240px; max-width: 70vw; height: 72px; background-color: var(--splash-stroke); -webkit-mask: url('${url}') center / contain no-repeat; mask: url('${url}') center / contain no-repeat;"></div>`;
  return replaceWith(html, /<svg\b[^>]*\baria-label="OpenChamber loading icon"[^>]*>[\s\S]*?<\/svg>/, () => mark);
};

/** @param {BrandedIndexOptions['splash']} splash */
const renderSplashStyle = (splash) => {
  const declarations = [];
  for (const [variant, colors] of [['light', splash.light], ['dark', splash.dark]]) {
    if (!colors) continue;
    declarations.push(`--splash-background-${variant}: ${colors.background};`, `--splash-stroke-${variant}: ${colors.foreground};`);
  }
  if (declarations.length === 0) return '';
  return `    <style id="multichamber-splash">:root { ${declarations.join(' ')} }</style>\n`;
};

/** @param {string} html @param {BrandedIndexOptions} options */
const injectHead = (html, { splash, clientConfig }) => {
  const script = `    <script id="${MULTICHAMBER_BRAND_ELEMENT_ID}" type="application/json">${serializeInlineJson(clientConfig)}</script>\n`;
  return replaceWith(html, /[ \t]*<\/head>/, (match) => `${renderSplashStyle(splash)}${script}${match}`);
};

/**
 * Rewrites a built `index.html` so the first paint already carries the brand.
 * @param {string} source
 * @param {BrandedIndexOptions} options
 * @returns {string}
 */
export const renderBrandedIndexHtml = (source, options) => {
  let html = applyName(source, options);
  html = applyIcons(html, options);
  html = applyThemeColor(html, options);
  html = applyLoadingMark(html, options);
  return injectHead(html, options);
};
