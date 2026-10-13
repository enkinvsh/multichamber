/**
 * Лимиты подписки Claude.
 *
 * Показывает лимиты, которыми связан сам Claude Code (скользящее окно сессии,
 * недельные окна, недельные окна по моделям и платный extra usage). Обычно читает
 * их по OAuth-входу, который уже есть у Claude Code; в слоте MultiChamber со своим
 * Claude читает с прокси zeny (MULTICHAMBER_CLAUDE_USAGE_URL), где лежит токен.
 *
 * @module quota/providers/claude
 */

import { createHash } from 'crypto';

import { buildResult } from '../../utils/index.js';
import { loadClaudeCredential } from './auth.js';
import { toClaudeUsage } from './transforms.js';

export const providerId = 'claude';
export const providerName = 'Claude';
export const aliases = ['anthropic', 'claude'];

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Last good payload, kept only to survive Anthropic's aggressive rate limiting.
 * Keyed by credential fingerprint so a second account never sees the first
 * account's numbers.
 *
 * @type {{ fingerprint: string, usage: object, planLabel: string|null }|null}
 */
let cachedUsage = null;
let cooldownUntil = 0;
let pendingFetch = null;

const fingerprintOf = (credential) =>
  createHash('sha256').update(`${credential.accessToken}\0${credential.refreshToken ?? ''}`).digest('hex');

const cooldownFromHeader = (response) => {
  const raw = response.headers.get('retry-after');
  const retryAfter = Number(raw);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_COOLDOWN_MS);
  }
  const retryAt = raw ? Date.parse(raw) : Number.NaN;
  if (Number.isFinite(retryAt) && retryAt > Date.now()) {
    return Math.min(retryAt - Date.now(), MAX_COOLDOWN_MS);
  }
  return DEFAULT_COOLDOWN_MS;
};

const cachedResultFor = (fingerprint, planLabel) => {
  if (!cachedUsage || cachedUsage.fingerprint !== fingerprint) return null;
  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage: cachedUsage.usage,
    planLabel: planLabel ?? cachedUsage.planLabel
  });
};

const failure = (error, { configured = true } = {}) =>
  buildResult({ providerId, providerName, ok: false, configured, error });

/**
 * Адрес лимитов на прокси zeny для слота MultiChamber, который работает на подписке
 * Claude владельца. Токен живёт на прокси, в контейнере его нет, поэтому прокси сам
 * отвечает в формате /api/oauth/usage и запрос к нему идёт без Authorization.
 * Только абсолютный http(s) без логина в URL, как у управляемого STT: адрес приходит
 * из runtime.env, и опечатка не должна увести запрос куда-то ещё.
 * @returns {string | null}
 */
const readManagedUsageUrl = () => {
  const value = (process.env.MULTICHAMBER_CLAUDE_USAGE_URL ?? '').trim();
  if (value.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.hostname.length === 0 || parsed.username || parsed.password) return null;
  return value;
};

/**
 * Откуда читать лимиты. Адрес прокси важнее локального входа Claude Code: в управляемом
 * слоте локальный токен, даже если он есть, не должен уходить на прокси.
 * Отпечаток прокси равен его адресу, поэтому кэш локального аккаунта не попадёт в ответ прокси.
 */
const resolveUsageSource = () => {
  const managedUrl = readManagedUsageUrl();
  if (managedUrl) {
    return { managed: true, url: managedUrl, headers: {}, fingerprint: managedUrl, planLabel: null };
  }
  const credential = loadClaudeCredential();
  if (!credential) return null;
  return {
    managed: false,
    url: USAGE_URL,
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      'anthropic-beta': OAUTH_BETA_HEADER
    },
    fingerprint: fingerprintOf(credential),
    planLabel: credential.planLabel
  };
};

export const isConfigured = () => readManagedUsageUrl() !== null || Boolean(loadClaudeCredential());

const fetchQuotaUncoalesced = async () => {
  const source = resolveUsageSource();
  if (!source) {
    return failure('Not configured', { configured: false });
  }

  const { fingerprint, planLabel } = source;
  if (cachedUsage && cachedUsage.fingerprint !== fingerprint) {
    cachedUsage = null;
    cooldownUntil = 0;
  }

  if (Date.now() < cooldownUntil) {
    return cachedResultFor(fingerprint, planLabel)
      ?? failure('Rate limited. Retrying soon.');
  }

  let response;
  try {
    response = await fetch(source.url, {
      method: 'GET',
      headers: source.headers
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'Request failed');
  }

  if (response.status === 429) {
    cooldownUntil = Date.now() + cooldownFromHeader(response);
    return cachedResultFor(fingerprint, planLabel)
      ?? failure('Rate limited. Retrying soon.');
  }

  // 404 от прокси значит, что подписка не подключена. Кэш сбрасываем: отпечаток прокси
  // не меняется между аккаунтами, и после переподключения старые цифры не должны всплыть.
  if (source.managed && response.status === 404) {
    cachedUsage = null;
    return failure('Not configured', { configured: false });
  }

  if (response.status === 401 || response.status === 403) {
    return failure(source.managed
      ? 'Claude access was revoked. Connect Claude again in the zeny cabinet: zenyweb.com/cabinet/claude.'
      : 'Claude session expired. Open Claude Code to sign in again.');
  }

  if (!response.ok) {
    return failure(`API error: ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return failure('Unexpected response from Anthropic');
  }

  const { windows, models } = toClaudeUsage(payload);
  const usage = Object.keys(models).length > 0 ? { windows, models } : { windows };
  cachedUsage = { fingerprint, usage, planLabel };

  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage,
    planLabel
  });
};

export const fetchQuota = () => {
  if (pendingFetch) return pendingFetch;

  const request = fetchQuotaUncoalesced();
  const pending = request.finally(() => {
    if (pendingFetch === pending) pendingFetch = null;
  });
  pendingFetch = pending;
  return pendingFetch;
};

/** Test seam: clears the rate-limit cache between cases. */
export const resetClaudeQuotaCache = () => {
  cachedUsage = null;
  cooldownUntil = 0;
  pendingFetch = null;
};
