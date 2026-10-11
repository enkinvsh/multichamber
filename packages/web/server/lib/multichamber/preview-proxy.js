import http from 'node:http';
import net from 'node:net';

/*
 * Прокси приватного превью dev-сервера: второй слой после мастера zeny.
 *
 * Мастер (Caddy) уже проверил владельца и шлёт сюда запросы через DNAT на
 * MULTICHAMBER_PREVIEW_PORT с Host вида <port>-<key>.<домен превью> и
 * заголовком X-Zeny-Preview-Port. Здесь заново проверяем Host и порт: агентский
 * Chromium в том же контейнере может прийти сюда напрямую или через DNS
 * rebinding, и прокси не должен давать ему ничего сверх того, что и так
 * доступно по 127.0.0.1:<port>. Поэтому служебные порты (сам multichamber,
 * OpenCode, этот прокси, ssh, всё ниже 1024) закрыты всегда, а кроме них закрыт
 * любой порт, чей слушающий сокет держит сам multichamber или процесс `opencode serve`
 * (у OpenCode несколько случайных loopback-портов помимо API).
 *
 * Требовать, чтобы dev-сервер был потомком multichamber, нельзя: агенты запускают
 * его через `nohup ... &`, `npm run dev &` или tmux, после выхода шелла инструмента
 * процесс переходит к PID 1, и превью отвечало бы 403 на самый частый случай
 * (замерено на слоте 2026-10-11).
 *
 * Только node:http/net: http-proxy-middleware из зависимостей не умеет
 * откатываться на ::1 по готовому сокету и проверять владельца порта до
 * отправки запроса.
 *
 * Модуль исполняется только под Node (дочерний процесс preview-proxy-main.js):
 * Bun 1.3 node:http игнорирует createConnection и не отдаёт сырой сокет при
 * upgrade, замерено 2026-10-11 (GET давал 502 ECONNREFUSED, WebSocket молчал).
 */

const HEADER_PORT = 'x-zeny-preview-port';
const CONNECT_TIMEOUT_MS = 10_000;
// Простаивающий HTTP-сокет держит дескриптор и память; dev-сервер, молчащий 5 минут, уже не ответит.
const HTTP_IDLE_TIMEOUT_MS = 5 * 60_000;
// HMR-сокеты молчат часами; без таймаута, а мёртвые соединения снимает TCP keepalive.
const WEBSOCKET_KEEPALIVE_MS = 60_000;
// Проверка владельца обходит весь /proc; страница dev-сервера тянет сотни модулей подряд.
const OWNERSHIP_CACHE_MS = 5_000;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
// 47765: порт агента zeny в контейнере; 22: ssh. Совпадает со списком мастера.
const ALWAYS_DENIED_PORTS = Object.freeze([22, 47765]);

const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

// Заголовки одного соединения: прокси не должен передавать их дальше (RFC 9110, 7.6.1).
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
// Эти заголовки выставляет сам прокси: клиентским значениям верить нельзя.
const REWRITTEN_HEADERS = new Set(['host', 'origin', HEADER_PORT, 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for']);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/**
 * Читает MULTICHAMBER_PREVIEW_PORT и MULTICHAMBER_PREVIEW_DOMAIN.
 * Без любого из них или с мусором прокси не запускается (null).
 * @param {Record<string, string | undefined>} env
 * @returns {{ port: number, domain: string } | null}
 */
export const readPreviewProxyConfig = (env = process.env) => {
  const rawPort = String(env.MULTICHAMBER_PREVIEW_PORT ?? '').trim();
  let domain = String(env.MULTICHAMBER_PREVIEW_DOMAIN ?? '').trim().toLowerCase();
  if (domain.endsWith('.')) domain = domain.slice(0, -1);
  if (!/^\d{1,5}$/.test(rawPort) || !DOMAIN_PATTERN.test(domain)) return null;
  const port = Number(rawPort);
  if (port < 1 || port > MAX_PORT) return null;
  return { port, domain };
};

/**
 * Редирект dev-сервера на http://localhost:<тот же порт>/... ведёт браузер владельца
 * на его собственную машину; переводим его на публичный хост превью.
 * @param {string} location
 * @param {number} port
 * @param {string} publicHost
 */
export const rewriteLocation = (location, port, publicHost) => {
  let parsed;
  try {
    parsed = new URL(location);
  } catch {
    // Относительный Location браузер и так разрешит относительно хоста превью.
    return location;
  }
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(parsed.hostname) || parsed.port !== String(port)) {
    return location;
  }
  return `https://${publicHost}${parsed.pathname}${parsed.search}${parsed.hash}`;
};

const PAGE_STYLE = 'body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#eee;'
  + 'display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center}'
  + 'main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.25rem;font-weight:600}'
  + 'p{color:#aaa;line-height:1.5}';

const renderPage = (title, hint) => '<!doctype html><html lang="ru"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">'
  + `<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>`
  + `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(hint)}</p></main></body></html>`;

const notRunningPage = (port) => renderPage(
  `На порту ${port} ничего не запущено`,
  'Запустите dev-сервер или попросите агента, затем обновите страницу.',
);

const deniedPage = (port) => renderPage(
  `Порт ${port} недоступен для превью`,
  'Это служебный порт окружения. Превью открывает только dev-серверы, запущенные в проекте.',
);

const STATUS_TEXT = { 400: 'Bad Request', 403: 'Forbidden', 421: 'Misdirected Request', 502: 'Bad Gateway' };

/** @typedef {{ status: number, type: 'text/plain' | 'text/html', body: string }} Rejection */

/** @returns {Rejection} */
const misdirected = (message) => ({ status: 421, type: 'text/plain', body: `${message}\n` });

const sendRejection = (res, { status, type, body }) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
};

const writeRawRejection = (socket, { status, type, body }) => {
  if (socket.destroyed) return;
  socket.end([
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
    `Content-Type: ${type}; charset=utf-8`,
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Cache-Control: no-store',
    'Connection: close',
    '',
    body,
  ].join('\r\n'));
};

const connectOnce = (host, port) => new Promise((resolve, reject) => {
  const socket = net.connect({ host, port });
  const fail = (error) => {
    clearTimeout(timer);
    socket.destroy();
    reject(error);
  };
  const timer = setTimeout(() => {
    const error = new Error(`connect to ${host}:${port} timed out`);
    error.code = 'ETIMEDOUT';
    fail(error);
  }, CONNECT_TIMEOUT_MS);
  socket.once('error', fail);
  socket.once('connect', () => {
    clearTimeout(timer);
    socket.removeListener('error', fail);
    resolve(socket);
  });
});

// Vite и прочие часто слушают только ::1 (localhost резолвится в IPv6), поэтому второй заход по ::1.
const connectUpstream = async (port) => {
  try {
    return await connectOnce('127.0.0.1', port);
  } catch (error) {
    if (error?.code !== 'ECONNREFUSED') throw error;
    return connectOnce('::1', port);
  }
};

const appendForwardedFor = (previous, remoteAddress) => {
  const parts = [];
  if (typeof previous === 'string' && previous.trim().length > 0) parts.push(previous.trim());
  if (typeof remoteAddress === 'string' && remoteAddress.length > 0) parts.push(remoteAddress.replace(/^::ffff:/, ''));
  return parts.join(', ');
};

const connectionTokens = (value) => String(value ?? '')
  .split(',')
  .map((token) => token.trim().toLowerCase())
  .filter((token) => token.length > 0);

/**
 * Заголовки для dev-сервера: исходные (с регистром и повторами) без hop-by-hop и подменяемых.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ port: number, publicHost: string }} target
 * @param {{ upgrade: boolean }} mode
 * @returns {Array<[string, string]>}
 */
const buildUpstreamHeaders = (req, { port, publicHost }, { upgrade }) => {
  const dropped = new Set([...HOP_BY_HOP_HEADERS, ...REWRITTEN_HEADERS, ...connectionTokens(req.headers.connection)]);
  const headers = [];
  for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index];
    if (!dropped.has(name.toLowerCase())) headers.push([name, req.rawHeaders[index + 1]]);
  }
  headers.push(['Host', `localhost:${port}`]);
  // dev-серверы (Vite, Next) сверяют Origin со своим адресом и режут WebSocket HMR с чужого.
  if (typeof req.headers.origin === 'string') headers.push(['Origin', `http://localhost:${port}`]);
  headers.push(['X-Forwarded-Host', publicHost]);
  headers.push(['X-Forwarded-Proto', 'https']);
  headers.push(['X-Forwarded-For', appendForwardedFor(req.headers['x-forwarded-for'], req.socket.remoteAddress)]);
  if (upgrade) {
    headers.push(['Connection', 'Upgrade']);
    headers.push(['Upgrade', String(req.headers.upgrade ?? 'websocket')]);
  }
  return headers;
};

const filterResponseHeaders = (upstreamRes, { port, publicHost }) => {
  const dropped = new Set([...HOP_BY_HOP_HEADERS, ...connectionTokens(upstreamRes.headers.connection)]);
  const headers = {};
  for (const [name, value] of Object.entries(upstreamRes.headers)) {
    if (value === undefined || dropped.has(name)) continue;
    headers[name] = name === 'location' && typeof value === 'string' ? rewriteLocation(value, port, publicHost) : value;
  }
  return headers;
};

/**
 * Проверка владельца порта с коротким кешем и склейкой одновременных запросов.
 * @param {(port: number) => Promise<boolean>} check
 * @param {{ ttlMs?: number, now?: () => number }} [options]
 * @returns {(port: number) => Promise<boolean>}
 */
export const createCachedPortCheck = (check, { ttlMs = OWNERSHIP_CACHE_MS, now = Date.now } = {}) => {
  const cache = new Map();
  return (port) => {
    const cached = cache.get(port);
    if (cached && cached.expiresAt > now()) return cached.result;
    const result = Promise.resolve().then(() => check(port));
    cache.set(port, { result, expiresAt: now() + ttlMs });
    result.then(
      (allowed) => {
        // Отказ не кешируем: только что запущенный агентом сервер должен открыться сразу.
        if (!allowed && cache.get(port)?.result === result) cache.delete(port);
      },
      () => {
        if (cache.get(port)?.result === result) cache.delete(port);
      },
    );
    return result;
  };
};

/**
 * Отдельный http.Server прокси превью (ещё не слушает порт).
 * Без resolvePortOwners (нет /proc: macOS, разработка) действует только статический список.
 * @param {{
 *   domain: string,
 *   logger?: { warn: (...args: unknown[]) => void },
 *   getDeniedPorts?: () => Array<number | null | undefined>,
 *   resolvePortOwners?: ((port: number) => Promise<number[]>) | null,
 *   isEnvironmentOwner?: (pid: number) => boolean | Promise<boolean>,
 * }} options
 * @returns {import('node:http').Server}
 */
export const createPreviewProxy = ({
  domain,
  logger = console,
  getDeniedPorts = () => [],
  resolvePortOwners = null,
  isEnvironmentOwner = () => false,
}) => {
  const isPortAllowed = resolvePortOwners
    ? createCachedPortCheck(async (port) => {
      const owners = await resolvePortOwners(port);
      const verdicts = await Promise.all(owners.map(async (pid) => pid === process.pid || await isEnvironmentOwner(pid)));
      return !verdicts.includes(true);
    })
    : async () => true;
  const hostPattern = new RegExp(`^([1-9][0-9]{3,4})-([a-z2-7]{12})\\.${escapeRegExp(domain)}$`);

  /**
   * Синхронные проверки до любого соединения с портом.
   * @returns {{ ok: true, port: number, publicHost: string } | { ok: false, rejection: Rejection }}
   */
  const evaluate = (req) => {
    const headerPort = req.headers[HEADER_PORT];
    if (typeof headerPort !== 'string' || !/^[0-9]{1,5}$/.test(headerPort)) {
      return { ok: false, rejection: misdirected('Missing preview port') };
    }
    // Порт в Host снимаем: мастер может прислать :443; IPv6-литералы до регулярки всё равно не дойдут.
    const publicHost = String(req.headers.host ?? '').replace(/:[0-9]+$/, '');
    const match = hostPattern.exec(publicHost);
    if (!match || match[1] !== headerPort) {
      return { ok: false, rejection: misdirected('Preview host mismatch') };
    }
    const port = Number(headerPort);
    if (port > MAX_PORT) return { ok: false, rejection: misdirected('Preview host mismatch') };
    if (typeof req.url !== 'string' || !req.url.startsWith('/')) {
      return { ok: false, rejection: { status: 400, type: 'text/plain', body: 'Bad request target\n' } };
    }
    const denied = port < MIN_PORT
      || ALWAYS_DENIED_PORTS.includes(port)
      || getDeniedPorts().some((deniedPort) => Number(deniedPort) === port);
    if (denied) return { ok: false, rejection: { status: 403, type: 'text/html', body: deniedPage(port) } };
    return { ok: true, port, publicHost };
  };

  /**
   * Соединение и проверка владельца параллельно: так «ничего не запущено» остаётся
   * понятной страницей, а не 403 (у незанятого порта владельца нет).
   * @returns {Promise<{ socket: net.Socket } | { rejection: Rejection }>}
   */
  const openUpstream = async (port) => {
    const [connected, allowed] = await Promise.all([
      connectUpstream(port).then((socket) => ({ socket }), (error) => ({ error })),
      // Сбой чтения /proc приравнен к его отсутствию: статический список уже проверен в evaluate,
      // а отказ здесь закрыл бы превью целиком из-за гонки с завершившимся процессом.
      Promise.resolve().then(() => isPortAllowed(port)).catch((error) => {
        logger.warn(`[preview-proxy] owner lookup for port ${port} failed: ${error?.message ?? error}`);
        return true;
      }),
    ]);
    if ('error' in connected) {
      if (connected.error?.code !== 'ECONNREFUSED') {
        logger.warn(`[preview-proxy] cannot reach port ${port}: ${connected.error?.code ?? connected.error?.message}`);
      }
      return { rejection: { status: 502, type: 'text/html', body: notRunningPage(port) } };
    }
    if (!allowed) {
      connected.socket.destroy();
      return { rejection: { status: 403, type: 'text/html', body: deniedPage(port) } };
    }
    return { socket: connected.socket };
  };

  const handleRequest = async (req, res) => {
    const verdict = evaluate(req);
    if (!verdict.ok) {
      sendRejection(res, verdict.rejection);
      return;
    }
    const opened = await openUpstream(verdict.port);
    if ('rejection' in opened) {
      sendRejection(res, opened.rejection);
      return;
    }
    const upstreamSocket = opened.socket;
    if (req.destroyed || res.destroyed) {
      upstreamSocket.destroy();
      return;
    }
    upstreamSocket.setTimeout(HTTP_IDLE_TIMEOUT_MS, () => upstreamSocket.destroy());

    const upstreamReq = http.request({
      method: req.method,
      path: req.url,
      headers: Object.fromEntries(groupHeaders(buildUpstreamHeaders(req, verdict, { upgrade: false }))),
      // Без agent: при agent:false node создаёт свой Agent и игнорирует createConnection.
      createConnection: () => upstreamSocket,
    });

    upstreamReq.on('response', (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, filterResponseHeaders(upstreamRes, verdict));
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => res.destroy());
      upstreamRes.on('aborted', () => res.destroy());
    });
    upstreamReq.on('error', (error) => {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      logger.warn(`[preview-proxy] upstream ${verdict.port} failed: ${error?.code ?? error?.message}`);
      sendRejection(res, { status: 502, type: 'text/html', body: notRunningPage(verdict.port) });
    });
    // Клиент ушёл раньше конца ответа: держать запрос к dev-серверу дальше незачем.
    res.on('close', () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });
    req.pipe(upstreamReq);
  };

  const handleUpgrade = async (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const verdict = evaluate(req);
    if (!verdict.ok) {
      writeRawRejection(socket, verdict.rejection);
      return;
    }
    const opened = await openUpstream(verdict.port);
    if ('rejection' in opened) {
      writeRawRejection(socket, opened.rejection);
      return;
    }
    const upstreamSocket = opened.socket;
    if (socket.destroyed) {
      upstreamSocket.destroy();
      return;
    }
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => socket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
    for (const side of [socket, upstreamSocket]) {
      side.setTimeout(0);
      side.setNoDelay(true);
      side.setKeepAlive(true, WEBSOCKET_KEEPALIVE_MS);
    }

    const headLines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [name, value] of buildUpstreamHeaders(req, verdict, { upgrade: true })) headLines.push(`${name}: ${value}`);
    upstreamSocket.write(`${headLines.join('\r\n')}\r\n\r\n`);
    if (head && head.length > 0) upstreamSocket.write(head);
    // Ответ dev-сервера (101 или отказ) уходит клиенту как есть, дальше это просто поток байтов.
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  };

  const server = http.createServer();
  server.timeout = HTTP_IDLE_TIMEOUT_MS;
  server.on('request', (req, res) => {
    handleRequest(req, res).catch((error) => {
      logger.warn(`[preview-proxy] request failed: ${error?.message ?? error}`);
      if (!res.headersSent) sendRejection(res, { status: 502, type: 'text/html', body: notRunningPage(Number(req.headers[HEADER_PORT]) || 0) });
      else res.destroy();
    });
  });
  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head).catch((error) => {
      logger.warn(`[preview-proxy] upgrade failed: ${error?.message ?? error}`);
      socket.destroy();
    });
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  return server;
};

// http.request с объектом заголовков: повторы одного имени склеиваются в массив, а не теряются.
const groupHeaders = (pairs) => {
  const grouped = new Map();
  for (const [name, value] of pairs) {
    const key = name.toLowerCase();
    const previous = grouped.get(key);
    if (previous === undefined) grouped.set(key, value);
    else grouped.set(key, Array.isArray(previous) ? [...previous, value] : [previous, value]);
  }
  return grouped;
};
