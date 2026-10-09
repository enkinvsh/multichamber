import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMultichamberBrand, readMultichamberBrandConfig } from './brand.js';
import { MULTICHAMBER_BRAND_ELEMENT_ID } from './index-html.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const stockIndexHtml = fs.readFileSync(path.resolve(here, '../../../index.html'), 'utf8');
const stockDarkTheme = JSON.parse(fs.readFileSync(path.resolve(here, '../../../../ui/src/lib/theme/themes/openchamber-dark.json'), 'utf8'));

const createLogger = () => {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(String(message)) };
};

const sampleTheme = (id, overrides = {}) => ({
  ...stockDarkTheme,
  metadata: { ...stockDarkTheme.metadata, id, name: id, variant: 'dark' },
  colors: {
    ...stockDarkTheme.colors,
    surface: { ...stockDarkTheme.colors.surface, background: '#101010', foreground: '#fafafa', ...overrides },
  },
});

let workDir = '';
let assetsDir = '';
let themesDir = '';
let distDir = '';

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multichamber-brand-'));
  assetsDir = path.join(workDir, 'brand');
  themesDir = path.join(workDir, 'themes');
  distDir = path.join(workDir, 'dist');
  for (const dir of [assetsDir, themesDir, distDir]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(distDir, 'index.html'), stockIndexHtml);
  fs.writeFileSync(path.join(distDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" id="stock"/>');
  fs.writeFileSync(path.join(distDir, 'pwa-192.png'), 'stock-png');
  fs.writeFileSync(path.join(distDir, 'secret.txt'), 'secret');
  fs.writeFileSync(path.join(workDir, 'outside.svg'), '<svg id="outside"/>');
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

const createBrand = (env, { userThemes = [], logger = createLogger() } = {}) => createMultichamberBrand({
  env,
  readUserThemes: async () => userThemes,
  maxThemeJsonBytes: 512 * 1024,
  logger,
});

const createApp = (brand) => {
  const app = express();
  brand.installRoutes(app, { distPath: distDir });
  return app;
};

const getAsText = (app, url) => request(app).get(url).buffer(true).parse((res, callback) => {
  let data = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => callback(null, data));
});

const readClientConfig = (html) => {
  const match = html.match(new RegExp(`<script id="${MULTICHAMBER_BRAND_ELEMENT_ID}" type="application/json">([^<]*)</script>`));
  return match ? JSON.parse(match[1]) : null;
};

describe('readMultichamberBrandConfig', () => {
  it('reads nothing from an empty environment', () => {
    const { config, invalid } = readMultichamberBrandConfig({});
    expect(invalid).toEqual([]);
    expect(config).toEqual({
      name: null,
      assetsDir: null,
      themesDir: null,
      defaultThemes: { dark: null, light: null },
      links: { account: null, plans: null, topup: null, support: null, logout: null },
      budgetUrl: null,
    });
  });

  it('keeps valid values and reports invalid ones by variable name only', () => {
    const { config, invalid } = readMultichamberBrandConfig({
      MULTICHAMBER_BRAND_NAME: '  Acme Cloud  ',
      MULTICHAMBER_DEFAULT_THEME_DARK: 'acme-dark',
      MULTICHAMBER_DEFAULT_THEME_LIGHT: '../escape',
      MULTICHAMBER_ACCOUNT_URL: 'https://example.test/account?token=secret',
      MULTICHAMBER_PLANS_URL: '/plans',
      MULTICHAMBER_TOPUP_URL: 'javascript:alert(1)',
      MULTICHAMBER_SUPPORT_URL: '//evil.test/support',
      MULTICHAMBER_LOGOUT_URL: '/\\evil.test',
      MULTICHAMBER_BUDGET_URL: '/relative/budget',
    });
    expect(config.name).toBe('Acme Cloud');
    expect(config.defaultThemes).toEqual({ dark: 'acme-dark', light: null });
    expect(config.links).toEqual({
      account: 'https://example.test/account?token=secret',
      plans: '/plans',
      topup: null,
      support: null,
      logout: null,
    });
    expect(config.budgetUrl).toBeNull();
    expect(invalid).toEqual([
      'MULTICHAMBER_DEFAULT_THEME_LIGHT',
      'MULTICHAMBER_TOPUP_URL',
      'MULTICHAMBER_SUPPORT_URL',
      'MULTICHAMBER_LOGOUT_URL',
      'MULTICHAMBER_BUDGET_URL',
    ]);
  });

  it('rejects names with control characters or over 64 characters', () => {
    expect(readMultichamberBrandConfig({ MULTICHAMBER_BRAND_NAME: 'Acme\nCloud' }).config.name).toBeNull();
    expect(readMultichamberBrandConfig({ MULTICHAMBER_BRAND_NAME: 'x'.repeat(65) }).config.name).toBeNull();
  });
});

describe('createMultichamberBrand', () => {
  it('stays stock when no variable is set', () => {
    expect(createBrand({})).toBeNull();
  });

  it('logs invalid variable names without their values', () => {
    const logger = createLogger();
    createBrand({ MULTICHAMBER_BUDGET_URL: 'ftp://secret-token@example.test' }, { logger });
    expect(logger.warnings).toEqual(['[multichamber] ignoring invalid MULTICHAMBER_BUDGET_URL']);
  });

  it('inlines the brand folder themes and the default themes, user themes winning on id conflicts', async () => {
    fs.writeFileSync(path.join(themesDir, 'acme-dark.json'), JSON.stringify(sampleTheme('acme-dark')));
    fs.writeFileSync(path.join(themesDir, 'acme-extra.json'), JSON.stringify(sampleTheme('acme-extra')));
    fs.writeFileSync(path.join(themesDir, 'shared.json'), JSON.stringify(sampleTheme('shared')));
    const userThemes = [sampleTheme('shared', { background: '#222222' }), sampleTheme('user-only')];
    const brand = createBrand(
      { MULTICHAMBER_THEMES_DIR: themesDir, MULTICHAMBER_DEFAULT_THEME_DARK: 'shared' },
      { userThemes },
    );

    const html = (await request(createApp(brand)).get('/')).text;
    const themes = readClientConfig(html).themes;

    expect(themes.map((theme) => theme.metadata.id).sort()).toEqual(['acme-dark', 'acme-extra', 'shared']);
    expect(themes.find((theme) => theme.metadata.id === 'shared').colors.surface.background).toBe('#222222');
    expect(html).toContain('--splash-background-dark: #222222;');
  });

  it('leaves a brand theme that a user theme shadows to the themes API', async () => {
    fs.writeFileSync(path.join(themesDir, 'shared.json'), JSON.stringify(sampleTheme('shared')));
    const brand = createBrand(
      { MULTICHAMBER_THEMES_DIR: themesDir },
      { userThemes: [sampleTheme('shared', { background: '#222222' })] },
    );

    const html = (await request(createApp(brand)).get('/')).text;

    expect(readClientConfig(html).themes).toEqual([]);
  });

  it('serves only allowlisted brand files and falls back to stock files', async () => {
    fs.writeFileSync(path.join(assetsDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" id="brand"/>');
    fs.writeFileSync(path.join(assetsDir, 'notes.txt'), 'not allowlisted');
    const app = createApp(createBrand({ MULTICHAMBER_BRAND_ASSETS_DIR: assetsDir }));

    const brandSvg = await getAsText(app, '/brand/favicon.svg');
    expect(brandSvg.status).toBe(200);
    expect(brandSvg.headers['x-content-type-options']).toBe('nosniff');
    expect(brandSvg.headers['content-security-policy']).toContain("default-src 'none'");
    expect(brandSvg.body).toContain('id="brand"');

    const stockIcon = await getAsText(app, '/brand/icon-192.png');
    expect(stockIcon.status).toBe(200);
    expect(stockIcon.body).toBe('stock-png');

    expect((await request(app).get('/brand/logo.svg')).status).toBe(404);
    expect((await request(app).get('/brand/notes.txt')).status).toBe(404);
    expect((await request(app).get('/brand/..%2Foutside.svg')).status).toBe(404);
    expect((await request(app).get('/brand/%2e%2e%2fdist%2fsecret.txt')).status).toBe(404);
  });

  it('renders the branded page for the root, index.html and SPA routes', async () => {
    fs.writeFileSync(path.join(assetsDir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    fs.writeFileSync(path.join(themesDir, 'acme-dark.json'), JSON.stringify(sampleTheme('acme-dark')));
    const brand = createBrand({
      MULTICHAMBER_BRAND_NAME: 'Acme',
      MULTICHAMBER_BRAND_ASSETS_DIR: assetsDir,
      MULTICHAMBER_THEMES_DIR: themesDir,
      MULTICHAMBER_DEFAULT_THEME_DARK: 'acme-dark',
      MULTICHAMBER_DEFAULT_THEME_LIGHT: 'missing-light',
      MULTICHAMBER_SUPPORT_URL: 'https://example.test/help',
      MULTICHAMBER_BUDGET_URL: 'https://example.test/budget',
    });
    const app = express();
    const sendIndexHtml = brand.installRoutes(app, { distPath: distDir });
    app.get('/sessions/abc', sendIndexHtml);

    for (const route of ['/', '/index.html', '/sessions/abc']) {
      const response = await request(app).get(route);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.text).toContain('<title>Acme</title>');
      const clientConfig = readClientConfig(response.text);
      expect(clientConfig).toMatchObject({
        name: 'Acme',
        logoUrl: '/brand/logo.svg',
        defaultThemes: { dark: 'acme-dark', light: 'missing-light' },
        links: { account: null, plans: null, topup: null, support: 'https://example.test/help', logout: null },
        budget: true,
      });
      expect(clientConfig.themes.map((theme) => theme.metadata.id)).toEqual(['acme-dark']);
      expect(response.text).toContain('--splash-background-dark: #101010;');
      expect(response.text).not.toContain('example.test/budget');
    }
  });

  it('serves the stock page when the brand cannot be rendered', async () => {
    const logger = createLogger();
    const failingReads = {
      ...fs.promises,
      readFile: async () => {
        throw new Error('read failed');
      },
    };
    const brand = createMultichamberBrand({
      env: { MULTICHAMBER_BRAND_NAME: 'Acme' },
      fsPromises: failingReads,
      readUserThemes: async () => [],
      maxThemeJsonBytes: 512 * 1024,
      logger,
    });

    const response = await request(createApp(brand)).get('/');

    expect(logger.warnings).toContain('[multichamber] serving stock index.html: read failed');
    expect(response.status).toBe(200);
    expect(response.text).toContain('<title>OpenChamber - AI Coding Assistant</title>');
  });

  it('brands the PWA manifest only with the files the kit ships', async () => {
    fs.writeFileSync(path.join(assetsDir, 'icon-192.png'), 'brand-png');
    const brand = createBrand({ MULTICHAMBER_BRAND_NAME: 'Acme', MULTICHAMBER_BRAND_ASSETS_DIR: assetsDir });
    const stockManifest = {
      background_color: '#151313',
      theme_color: '#edb449',
      icons: [{ src: '/pwa-192.png' }],
      shortcuts: [{ name: 'Settings', icons: [{ src: '/pwa-192.png' }] }],
    };

    const manifestBrand = await brand.resolveManifestBrand();
    const manifest = manifestBrand.apply(stockManifest);

    expect(manifestBrand.name).toBe('Acme');
    expect(manifest.icons).toEqual([{ src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }]);
    expect(manifest.shortcuts[0].icons).toEqual([{ src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' }]);
    expect(manifest.background_color).toBe('#151313');
    expect(stockManifest.icons).toEqual([{ src: '/pwa-192.png' }]);
  });
});
