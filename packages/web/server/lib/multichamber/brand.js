/**
 * Env-driven white label for a host product: name, icons, logo, default
 * themes, account links and the budget indicator. Every variable is optional;
 * with none of them set `createMultichamberBrand` returns null and the server
 * stays stock. The contract is documented in DOCUMENTATION.md ("White label").
 *
 * The brand reaches the browser through the served `index.html` only (see
 * index-html.js), so it applies to the web and hosted-mobile surfaces that load
 * the page from this server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { createThemeRuntime } from '../opencode/theme-runtime.js';
import { renderBrandedIndexHtml } from './index-html.js';

const MULTICHAMBER_BRAND_ROUTE_PREFIX = '/brand';

/**
 * The only files served under `/brand/`, each with the stock file from the
 * built UI that answers when the operator did not ship it. The logo has no
 * stock counterpart: the UI keeps its own mark.
 */
const BRAND_ASSETS = new Map([
  ['favicon.svg', 'favicon.svg'],
  ['favicon.ico', 'favicon-32.png'],
  ['apple-touch-icon-180x180.png', 'apple-touch-icon-180x180.png'],
  ['apple-touch-icon-167x167.png', 'apple-touch-icon-167x167.png'],
  ['apple-touch-icon-152x152.png', 'apple-touch-icon-152x152.png'],
  ['icon-192.png', 'pwa-192.png'],
  ['icon-512.png', 'pwa-512.png'],
  ['logo.svg', null],
]);

const MAX_NAME_LENGTH = 64;
const SHORT_NAME_LENGTH = 30;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const THEME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const LINK_BASE_ORIGIN = 'http://multichamber.invalid';
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const envTextSchema = z.string().trim().catch('');
const colorSchema = z.string().regex(HEX_COLOR_PATTERN).nullable().catch(null);

/** @param {string} value */
const isHttpUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

/** An absolute http(s) URL, or a path on this origin such as `/account`. */
const isSafeLink = (value) => {
  if (!value.startsWith('/')) return isHttpUrl(value);
  try {
    // Rejects `//host` and `/\host`, which browsers resolve to another origin.
    return new URL(value, LINK_BASE_ORIGIN).origin === LINK_BASE_ORIGIN;
  } catch {
    return false;
  }
};

/** @param {string} value */
const isBrandName = (value) => value.length <= MAX_NAME_LENGTH && !CONTROL_CHARACTERS.test(value);

/** @param {string} value */
const isThemeId = (value) => THEME_ID_PATTERN.test(value);

const isAnyText = () => true;

/**
 * @typedef {{
 *   account: string | null,
 *   plans: string | null,
 *   topup: string | null,
 *   support: string | null,
 *   logout: string | null,
 * }} MultichamberBrandLinks
 * @typedef {{
 *   name: string | null,
 *   assetsDir: string | null,
 *   themesDir: string | null,
 *   defaultThemes: { dark: string | null, light: string | null },
 *   links: MultichamberBrandLinks,
 *   budgetUrl: string | null,
 * }} MultichamberBrandConfig
 */

/**
 * Reads the white-label variables. Values that fail validation are dropped
 * and reported by variable name only: links and the budget URL can carry
 * credentials, so values are never echoed.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ config: MultichamberBrandConfig, invalid: string[] }}
 */
export const readMultichamberBrandConfig = (env = process.env) => {
  /** @type {string[]} */
  const invalid = [];
  /** @param {string} name @param {(value: string) => boolean} isValid */
  const read = (name, isValid) => {
    const value = envTextSchema.parse(env[name]);
    if (!value) return null;
    if (isValid(value)) return value;
    invalid.push(name);
    return null;
  };
  /** @param {string | null} value */
  const toDirectory = (value) => (value ? path.resolve(value) : null);

  return {
    config: {
      name: read('MULTICHAMBER_BRAND_NAME', isBrandName),
      assetsDir: toDirectory(read('MULTICHAMBER_BRAND_ASSETS_DIR', isAnyText)),
      themesDir: toDirectory(read('MULTICHAMBER_THEMES_DIR', isAnyText)),
      defaultThemes: {
        dark: read('MULTICHAMBER_DEFAULT_THEME_DARK', isThemeId),
        light: read('MULTICHAMBER_DEFAULT_THEME_LIGHT', isThemeId),
      },
      links: {
        account: read('MULTICHAMBER_ACCOUNT_URL', isSafeLink),
        plans: read('MULTICHAMBER_PLANS_URL', isSafeLink),
        topup: read('MULTICHAMBER_TOPUP_URL', isSafeLink),
        support: read('MULTICHAMBER_SUPPORT_URL', isSafeLink),
        logout: read('MULTICHAMBER_LOGOUT_URL', isSafeLink),
      },
      budgetUrl: read('MULTICHAMBER_BUDGET_URL', isHttpUrl),
    },
    invalid,
  };
};

/** @param {MultichamberBrandConfig} config */
const isBrandConfigured = (config) => [
  config.name,
  config.assetsDir,
  config.themesDir,
  config.defaultThemes.dark,
  config.defaultThemes.light,
  ...Object.values(config.links),
  config.budgetUrl,
].some((value) => value !== null);

/**
 * @typedef {{
 *   metadata: { id: string, variant: string },
 *   colors: { surface: { background: string, foreground: string } },
 * }} BrandTheme
 */

/** @param {BrandTheme | null} theme */
const toSplashColors = (theme) => {
  const background = colorSchema.parse(theme?.colors?.surface?.background ?? null);
  const foreground = colorSchema.parse(theme?.colors?.surface?.foreground ?? null);
  return background && foreground ? { background, foreground } : null;
};

/** @param {string} value */
const toShortName = (value) => Array.from(value).slice(0, SHORT_NAME_LENGTH).join('');

/** @param {import('express').Response} res */
const finishSendFile = (res) => (/** @type {Error | undefined} */ error) => {
  if (error && !res.headersSent) res.status(404).end();
};

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   fsPromises?: typeof fs.promises,
 *   readUserThemes: () => Promise<BrandTheme[]>,
 *   maxThemeJsonBytes: number,
 *   logger?: Pick<Console, 'warn'>,
 * }} options
 */
export const createMultichamberBrand = ({
  env = process.env,
  fsPromises = fs.promises,
  readUserThemes,
  maxThemeJsonBytes,
  logger = console,
}) => {
  const { config, invalid } = readMultichamberBrandConfig(env);
  for (const name of invalid) {
    logger.warn(`[multichamber] ignoring invalid ${name}`);
  }
  if (!isBrandConfigured(config)) return null;

  for (const [name, directory] of [['MULTICHAMBER_BRAND_ASSETS_DIR', config.assetsDir], ['MULTICHAMBER_THEMES_DIR', config.themesDir]]) {
    if (!directory) continue;
    void fsPromises.stat(directory).then(
      (stats) => {
        if (!stats.isDirectory()) logger.warn(`[multichamber] ${name} is not a directory, using stock files`);
      },
      () => logger.warn(`[multichamber] ${name} does not exist, using stock files`),
    );
  }

  const brandThemeRuntime = config.themesDir
    ? createThemeRuntime({ fsPromises, path, themesDir: config.themesDir, maxThemeJsonBytes, logger })
    : null;

  /** @returns {Promise<BrandTheme[]>} */
  const readBrandThemes = async () => {
    if (!brandThemeRuntime) return [];
    // theme-runtime already logged why the directory is unreadable; brand themes are optional.
    return brandThemeRuntime.readCustomThemesFromDisk().catch(() => []);
  };

  /**
   * Themes inlined into the page: the brand folder's themes plus the two
   * default themes, which may also live in the user's folder. A user theme wins
   * on an id conflict, as custom themes do in the UI. Inlined themes behave like
   * built-ins there (present on first paint, not deletable), so
   * `GET /api/config/themes` keeps listing only the user's own themes.
   */
  const readPageThemes = async () => {
    const [userThemes, brandThemes] = await Promise.all([
      // A broken user theme directory must not take the page down; the themes API reports it.
      readUserThemes().catch(() => []),
      readBrandThemes(),
    ]);
    const userIds = new Set(userThemes.map((theme) => theme.metadata.id));
    const themesById = new Map([...brandThemes, ...userThemes].map((theme) => [theme.metadata.id, theme]));
    /** @param {string | null} id @param {'dark' | 'light'} variant */
    const findDefault = (id, variant) => {
      const theme = id ? themesById.get(id) : undefined;
      return theme && theme.metadata.variant === variant ? theme : null;
    };
    const dark = findDefault(config.defaultThemes.dark, 'dark');
    const light = findDefault(config.defaultThemes.light, 'light');
    /** @type {Map<string, BrandTheme>} */
    const inline = new Map();
    for (const theme of [dark, light, ...brandThemes.filter((candidate) => !userIds.has(candidate.metadata.id))]) {
      if (theme && !inline.has(theme.metadata.id)) inline.set(theme.metadata.id, theme);
    }
    return { dark, light, themes: [...inline.values()] };
  };

  /** @param {string} file */
  const brandFilePath = (file) => (config.assetsDir ? path.join(config.assetsDir, file) : null);

  /** @param {string} file */
  const isBrandFilePresent = async (file) => {
    const filePath = brandFilePath(file);
    if (!filePath) return false;
    const stats = await fsPromises.stat(filePath).catch(() => null);
    return stats?.isFile() ?? false;
  };

  /** Brand state shared by the page and the manifest, resolved per request so a redeployed kit needs no restart. */
  const resolveView = async () => {
    const files = [...BRAND_ASSETS.keys()];
    const [presence, pageThemes] = await Promise.all([
      Promise.all(files.map(isBrandFilePresent)),
      readPageThemes(),
    ]);
    const present = new Set(files.filter((_file, index) => presence[index]));
    /** @param {string} file */
    const assetUrl = (file) => (present.has(file) ? `${MULTICHAMBER_BRAND_ROUTE_PREFIX}/${file}` : null);
    const splash = { dark: toSplashColors(pageThemes.dark), light: toSplashColors(pageThemes.light) };
    return {
      assetUrl,
      splash,
      themeColor: (splash.dark ?? splash.light)?.background ?? null,
      client: {
        name: config.name,
        logoUrl: assetUrl('logo.svg'),
        defaultThemes: config.defaultThemes,
        themes: pageThemes.themes,
        links: config.links,
        budget: config.budgetUrl !== null,
      },
    };
  };

  /** @param {string} indexHtmlPath */
  const createIndexHtmlHandler = (indexHtmlPath) => async (
    /** @type {import('express').Request} */ _req,
    /** @type {import('express').Response} */ res,
  ) => {
    try {
      const [source, view] = await Promise.all([fsPromises.readFile(indexHtmlPath, 'utf8'), resolveView()]);
      const html = renderBrandedIndexHtml(source, {
        name: config.name,
        shortName: config.name ? toShortName(config.name) : null,
        icons: {
          svg: view.assetUrl('favicon.svg'),
          ico: view.assetUrl('favicon.ico'),
          appleTouch: {
            '180x180': view.assetUrl('apple-touch-icon-180x180.png'),
            '167x167': view.assetUrl('apple-touch-icon-167x167.png'),
            '152x152': view.assetUrl('apple-touch-icon-152x152.png'),
          },
        },
        logoUrl: view.client.logoUrl,
        splash: view.splash,
        themeColor: view.themeColor,
        clientConfig: view.client,
      });
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(html);
    } catch (error) {
      logger.warn(`[multichamber] serving stock index.html: ${error instanceof Error ? error.message : String(error)}`);
      res.sendFile(indexHtmlPath, finishSendFile(res));
    }
  };

  /**
   * Registers `/brand/<file>` and the branded page for `/` and `/index.html`.
   * Must run before `express.static`, which would answer those paths with the
   * stock page. Returns the page handler for the SPA fallback.
   * @param {import('express').Express} app
   * @param {{ distPath: string }} options
   */
  const installRoutes = (app, { distPath }) => {
    app.get(`${MULTICHAMBER_BRAND_ROUTE_PREFIX}/:file`, async (req, res) => {
      const file = req.params.file;
      if (!BRAND_ASSETS.has(file)) {
        res.status(404).end();
        return;
      }
      const filePath = brandFilePath(file);
      if (filePath && (await isBrandFilePresent(file))) {
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (file.endsWith('.svg')) res.setHeader('Content-Security-Policy', SVG_CONTENT_SECURITY_POLICY);
        res.sendFile(filePath, finishSendFile(res));
        return;
      }
      const stockFile = BRAND_ASSETS.get(file);
      if (!stockFile) {
        res.status(404).end();
        return;
      }
      res.sendFile(path.resolve(distPath, stockFile), finishSendFile(res));
    });

    const sendIndexHtml = createIndexHtmlHandler(path.resolve(distPath, 'index.html'));
    app.get(['/', '/index.html'], sendIndexHtml);
    return sendIndexHtml;
  };

  /**
   * Brand overrides for `/manifest.webmanifest`. Stock icons stay when the kit
   * ships none of the manifest-sized ones.
   */
  const resolveManifestBrand = async () => {
    const view = await resolveView();
    const icons = [
      ['icon-192.png', '192x192', 'image/png'],
      ['icon-512.png', '512x512', 'image/png'],
      ['apple-touch-icon-180x180.png', '180x180', 'image/png'],
      ['apple-touch-icon-152x152.png', '152x152', 'image/png'],
      ['favicon.svg', 'any', 'image/svg+xml'],
    ].flatMap(([file, sizes, type]) => {
      const src = view.assetUrl(file);
      return src ? [{ src, sizes, type, purpose: 'any' }] : [];
    });
    const shortcutIconUrl = view.assetUrl('icon-192.png');
    const shortcutIcons = shortcutIconUrl ? [{ src: shortcutIconUrl, sizes: '192x192', type: 'image/png' }] : null;

    return {
      name: config.name,
      /**
       * @template {{ background_color: string, theme_color: string, icons: object[], shortcuts: { icons: object[] }[] }} T
       * @param {T} manifest
       * @returns {T}
       */
      apply: (manifest) => ({
        ...manifest,
        background_color: view.themeColor ?? manifest.background_color,
        theme_color: view.themeColor ?? manifest.theme_color,
        icons: icons.length > 0 ? icons : manifest.icons,
        shortcuts: shortcutIcons
          ? manifest.shortcuts.map((shortcut) => ({ ...shortcut, icons: shortcutIcons }))
          : manifest.shortcuts,
      }),
    };
  };

  return {
    config,
    installRoutes,
    resolveManifestBrand,
  };
};
