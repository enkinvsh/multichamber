import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MULTICHAMBER_BRAND_ELEMENT_ID, renderBrandedIndexHtml, serializeInlineJson } from './index-html.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// The real page: an upstream change to one of the anchors fails here instead of silently going stock.
const source = fs.readFileSync(path.resolve(here, '../../../index.html'), 'utf8');

const unbranded = {
  name: null,
  shortName: null,
  icons: { svg: null, ico: null, appleTouch: { '180x180': null, '167x167': null, '152x152': null } },
  logoUrl: null,
  splash: { light: null, dark: null },
  themeColor: null,
  clientConfig: { name: null },
};

const fullBrand = {
  name: 'Acme $& "Cloud"',
  shortName: 'Acme',
  icons: {
    svg: '/brand/favicon.svg',
    ico: '/brand/favicon.ico',
    appleTouch: { '180x180': '/brand/apple-touch-icon-180x180.png', '167x167': null, '152x152': '/brand/apple-touch-icon-152x152.png' },
  },
  logoUrl: '/brand/logo.svg',
  splash: { light: { background: '#ffffff', foreground: '#111111' }, dark: { background: '#000000', foreground: '#eeeeee' } },
  themeColor: '#000000',
  clientConfig: { name: 'Acme', note: '</script><script>alert(1)</script>' },
};

const head = (html) => html.slice(0, html.indexOf('</head>'));

describe('renderBrandedIndexHtml', () => {
  it('finds every anchor in the shipped index.html', () => {
    expect(source).toContain("const defaultAppName = 'OpenChamber';");
    expect(source).toContain("const defaultShortName = 'OpenChamber';");
    expect(source).toContain('<title>OpenChamber - AI Coding Assistant</title>');
    expect(source).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    expect(source).toContain('<link rel="mask-icon" href="/favicon.svg"');
    expect(source).toContain('aria-label="OpenChamber loading icon"');
    expect(source).toMatch(/<link rel="apple-touch-icon" sizes="167x167" href="\/apple-touch-icon-167x167.png" \/>/);
  });

  it('keeps the page stock apart from the config element when nothing is branded', () => {
    const html = renderBrandedIndexHtml(source, unbranded);
    expect(html.replace(/ {4}<script id="multichamber-brand"[^\n]*\n/, '')).toBe(source);
    expect(html).toContain(`<script id="${MULTICHAMBER_BRAND_ELEMENT_ID}" type="application/json">{"name":null}</script>`);
  });

  it('applies name, icons, colours and logo with escaping', () => {
    const html = renderBrandedIndexHtml(source, fullBrand);
    const pageHead = head(html);

    expect(pageHead).toContain('<title>Acme $&amp; &quot;Cloud&quot;</title>');
    expect(pageHead).toContain('const defaultAppName = "Acme $\\u0026 \\"Cloud\\"";');
    expect(pageHead).toContain('const defaultShortName = "Acme";');
    expect(pageHead).not.toContain('content="OpenChamber"');
    expect(pageHead.match(/<meta name="apple-mobile-web-app-title" content="Acme \$&amp; &quot;Cloud&quot;" \/>/g)).toHaveLength(2);

    expect(pageHead).toContain('<link rel="icon" href="/brand/favicon.ico" sizes="32x32" />');
    expect(pageHead).toContain('<link rel="icon" type="image/svg+xml" href="/brand/favicon.svg" />');
    expect(pageHead).not.toContain('<link rel="icon" type="image/png"');
    expect(pageHead).not.toContain('rel="mask-icon"');
    expect(pageHead).toContain('<link rel="apple-touch-icon" sizes="180x180" href="/brand/apple-touch-icon-180x180.png" />');
    expect(pageHead).toContain('<link rel="apple-touch-icon" sizes="152x152" href="/brand/apple-touch-icon-152x152.png" />');
    expect(pageHead).not.toContain('sizes="167x167"');

    expect(pageHead).not.toContain('content="#151313"');
    expect(pageHead).toContain('<meta name="theme-color" content="#000000" />');
    expect(pageHead).toContain('<style id="multichamber-splash">:root { --splash-background-light: #ffffff; --splash-stroke-light: #111111; --splash-background-dark: #000000; --splash-stroke-dark: #eeeeee; }</style>');

    expect(html).not.toContain('aria-label="OpenChamber loading icon"');
    expect(html).toContain("mask: url('/brand/logo.svg') center / contain no-repeat;");
    expect(html).toContain('role="img" aria-label="Acme $&amp; &quot;Cloud&quot;"');

    const script = html.match(/<script id="multichamber-brand" type="application\/json">([^\n]*)<\/script>/);
    expect(script?.[1]).not.toContain('</script>');
    expect(JSON.parse(script?.[1] ?? 'null')).toEqual(fullBrand.clientConfig);
  });

  it('replaces the stock SVG favicon when the kit only ships an ICO', () => {
    const html = renderBrandedIndexHtml(source, { ...unbranded, icons: { ...unbranded.icons, ico: '/brand/favicon.ico' } });
    expect(head(html)).toContain('<link rel="icon" href="/brand/favicon.ico" sizes="32x32" />');
    expect(head(html)).not.toContain('href="/favicon.svg"');
  });
});

describe('serializeInlineJson', () => {
  it('escapes sequences that could end or confuse an inline script', () => {
    expect(serializeInlineJson({ value: '</script><!-- & \u2028' })).toBe('{"value":"\\u003c/script\\u003e\\u003c!-- \\u0026 \\u2028"}');
  });
});
