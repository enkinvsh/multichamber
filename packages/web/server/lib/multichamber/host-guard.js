import net from 'node:net';

/*
 * Защита от DNS rebinding и межсайтовых запросов к серверу на :3000.
 *
 * Зачем: в zeny агент управляет Chromium в том же контейнере, а OpenChamber
 * на :3000 открыт в LAN без входа (OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN=true).
 * Любая страница, которую откроет агент, может перепривязать свой домен на
 * 127.0.0.1 (DNS rebinding) или просто отправить POST/WebSocket на localhost.
 * Local Network Access в Chromium это не гарантирует закрыть: политика
 * меняется от версии к версии и не трогает часть запросов.
 *
 * Поэтому: Host должен быть IP-литералом, localhost или хостом из
 * MULTICHAMBER_ALLOWED_HOSTS (rebinding не может подставить IP-литерал в Host),
 * а запись и WebSocket из браузера должны идти с того же origin.
 * Включается только при заданном MULTICHAMBER_ALLOWED_HOSTS.
 */

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOG_INTERVAL_MS = 60_000;
// Ключи лога приходят из заголовков атакующего: без потолка карта растёт без конца.
const LOG_KEYS_LIMIT = 1000;

const HOST_NOT_ALLOWED = 'Host not allowed';
const CROSS_SITE_BLOCKED = 'Cross-site request blocked';

const STATUS_LINES = {
  403: 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n',
  421: 'HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n',
};

/**
 * Имя хоста без порта, квадратных скобок IPv6 и одной точки в конце, в нижнем регистре.
 * @param {string} value
 */
const normalizeHostname = (value) => {
  const trimmed = value.trim().toLowerCase();
  let hostname = trimmed;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    hostname = end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  } else if (trimmed.indexOf(':') !== -1 && trimmed.indexOf(':') === trimmed.lastIndexOf(':')) {
    hostname = trimmed.slice(0, trimmed.indexOf(':'));
  }
  return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
};

/**
 * Разбирает MULTICHAMBER_ALLOWED_HOSTS (имена через запятую, без портов).
 * Пустое или незаданное значение даёт null: защита выключена.
 * @param {string | undefined} raw
 * @returns {Set<string> | null}
 */
export const parseAllowedHosts = (raw) => {
  const hosts = String(raw ?? '')
    .split(',')
    .map((entry) => normalizeHostname(entry))
    .filter((entry) => entry.length > 0);
  return hosts.length > 0 ? new Set(hosts) : null;
};

/** @param {import('node:http').IncomingHttpHeaders} headers */
const readHostHeader = (headers) => {
  const host = headers.host ?? headers[':authority'];
  return typeof host === 'string' ? host.trim().toLowerCase() : '';
};

/**
 * @param {string} hostname
 * @param {Set<string>} allowedHosts
 */
const isHostnameAllowed = (hostname, allowedHosts) =>
  net.isIP(hostname) !== 0
  || hostname === 'localhost'
  || hostname.endsWith('.localhost')
  || allowedHosts.has(hostname);

/**
 * Same-origin (host:port Origin совпадает с Host, который уже прошёл проверку)
 * или https-origin из списка разрешённых.
 * @param {string} origin
 * @param {string} hostHeader
 * @param {Set<string>} allowedHosts
 */
const isOriginAllowed = (origin, hostHeader, allowedHosts) => {
  if (origin === 'null') return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.host === hostHeader) return true;
  return url.protocol === 'https:' && allowedHosts.has(normalizeHostname(url.hostname));
};

/**
 * @typedef {{ allowed: true } | { allowed: false, status: 403 | 421, reason: 'host' | 'sec-fetch-site' | 'origin', host: string }} HostGuardDecision
 */

/**
 * Решение по запросу. Хост проверяется всегда; Origin и Sec-Fetch-Site только
 * у POST/PUT/PATCH/DELETE и у любого WebSocket upgrade. Чтения (GET/HEAD/OPTIONS)
 * не проверяются на межсайтовость: ответ им и так закрывает CORS.
 * Запрос без Origin и без Sec-Fetch-Site идёт не из браузера (плагин OpenCode,
 * curl, heartbeat, проверки оркестратора) и пропускается.
 * @param {{ allowedHosts: Set<string>, method: string | undefined, headers: import('node:http').IncomingHttpHeaders, upgrade: boolean }} input
 * @returns {HostGuardDecision}
 */
export const evaluateHostGuard = ({ allowedHosts, method, headers, upgrade }) => {
  const host = readHostHeader(headers);
  if (!isHostnameAllowed(normalizeHostname(host), allowedHosts)) {
    return { allowed: false, status: 421, reason: 'host', host };
  }
  if (!upgrade && !WRITE_METHODS.has(String(method).toUpperCase())) return { allowed: true };
  if (headers['sec-fetch-site'] === 'cross-site') {
    return { allowed: false, status: 403, reason: 'sec-fetch-site', host };
  }
  const origin = headers.origin;
  if (typeof origin === 'string' && !isOriginAllowed(origin.trim(), host, allowedHosts)) {
    return { allowed: false, status: 403, reason: 'origin', host };
  }
  return { allowed: true };
};

/**
 * Пишет предупреждение не чаще раза в минуту на пару (причина, хост),
 * чтобы перебор хостов не залил лог.
 * @param {Pick<Console, 'warn'>} logger
 * @param {() => number} now
 */
const createRejectionLogger = (logger, now) => {
  /** @type {Map<string, number>} */
  const lastLogged = new Map();
  /** @param {Extract<HostGuardDecision, { allowed: false }>} decision */
  return (decision) => {
    const key = `${decision.reason}\u0000${decision.host}`;
    const time = now();
    const previous = lastLogged.get(key);
    if (previous !== undefined && time - previous < LOG_INTERVAL_MS) return;
    if (lastLogged.size >= LOG_KEYS_LIMIT) lastLogged.clear();
    lastLogged.set(key, time);
    logger.warn(`[multichamber] host guard rejected request: reason=${decision.reason} host=${JSON.stringify(decision.host)}`);
  };
};

/**
 * Защита Host/Origin. Возвращает null, когда MULTICHAMBER_ALLOWED_HOSTS не задан:
 * тогда сервер ведёт себя как прежде.
 * `middleware` ставится первым в Express, `installOnServer` закрывает все
 * обработчики `upgrade` (терминал, диктовка, event stream, realtime proxy, dev tunnel).
 * @param {{ env?: NodeJS.ProcessEnv, logger?: Pick<Console, 'warn'>, now?: () => number }} [options]
 */
export const createHostGuard = ({ env = process.env, logger = console, now = Date.now } = {}) => {
  const allowedHosts = parseAllowedHosts(env.MULTICHAMBER_ALLOWED_HOSTS);
  if (allowedHosts === null) return null;
  const logRejection = createRejectionLogger(logger, now);

  /** @type {import('express').RequestHandler} */
  const middleware = (req, res, next) => {
    const decision = evaluateHostGuard({ allowedHosts, method: req.method, headers: req.headers, upgrade: false });
    if (decision.allowed) {
      next();
      return;
    }
    logRejection(decision);
    res.status(decision.status).type('text/plain').send(decision.status === 421 ? HOST_NOT_ALLOWED : CROSS_SITE_BLOCKED);
  };

  /**
   * Проверяет upgrade-запрос. При отказе пишет сырой статус и закрывает сокет.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @returns {boolean} true, если запрос можно передавать дальше
   */
  const guardUpgrade = (req, socket) => {
    const decision = evaluateHostGuard({ allowedHosts, method: req.method, headers: req.headers, upgrade: true });
    if (decision.allowed) return true;
    logRejection(decision);
    if (!socket.destroyed) {
      socket.write(STATUS_LINES[decision.status]);
      socket.destroy();
    }
    return false;
  };

  /**
   * Каждый runtime вешает свой `server.on('upgrade')`, и Node вызывает их все.
   * Отказ в одном слушателе не остановит остальные, поэтому событие отсекается
   * в `emit`, до всех слушателей, в том числе добавленных позже.
   * @param {import('node:http').Server} server
   */
  const installOnServer = (server) => {
    const emit = server.emit;
    server.emit = function emitWithHostGuard(event, ...args) {
      if (event === 'upgrade' && !guardUpgrade(args[0], args[1])) return true;
      return emit.call(this, event, ...args);
    };
  };

  return { middleware, guardUpgrade, installOnServer };
};
