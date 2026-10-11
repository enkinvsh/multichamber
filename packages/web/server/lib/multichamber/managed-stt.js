/**
 * Управляемое распознавание речи: адрес OpenAI-совместимого STT задаёт хост
 * контейнера (zeny пишет его в runtime.env), а не пользователь. Когда адрес
 * задан, диктовка всегда идёт туда, что бы ни прислал клиент, а локальная
 * модель Parakeet в контейнере не скачивается и не запускается.
 */

const DEFAULT_MANAGED_STT_MODEL = 'parakeet-tdt-0.6b-v3';

// Без ключа stt.js подставил бы OPENAI_API_KEY сервера и отправил чужой секрет
// на управляемый адрес, поэтому «ключа нет» передаётся явной заглушкой.
const NO_API_KEY = 'not-required';

/** @param {string | undefined} value */
const trimmed = (value) => (value ?? '').trim();

/**
 * @param {string} value
 * @returns {boolean}
 */
const isHttpUrl = (value) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    && parsed.hostname.length > 0
    && !parsed.username
    && !parsed.password;
};

/**
 * Настройки управляемого STT из окружения; null, если адрес не задан или не
 * абсолютный http(s) без логина в URL.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ baseUrl: string, model: string, apiKey: string } | null}
 */
export const readManagedStt = (env = process.env) => {
  const baseUrl = trimmed(env.MULTICHAMBER_STT_BASE_URL);
  if (baseUrl.length === 0 || !isHttpUrl(baseUrl)) return null;
  return {
    baseUrl,
    model: trimmed(env.MULTICHAMBER_STT_MODEL) || DEFAULT_MANAGED_STT_MODEL,
    apiKey: trimmed(env.MULTICHAMBER_STT_KEY) || trimmed(env.MULTICHAMBER_LLM_KEY) || NO_API_KEY,
  };
};
