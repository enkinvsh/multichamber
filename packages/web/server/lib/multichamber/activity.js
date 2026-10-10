/**
 * `POST|GET /api/multichamber/activity`: когда пользователь в последний раз
 * что-то делал руками (клавиша, клик, прокрутка, касание). Хост слота читает
 * это, чтобы усыпить машину без ввода: открытая вкладка сама по себе шлёт
 * фоновые запросы (ping WebSocket, видимость, опрос сессий и бюджета), поэтому
 * по соединениям и трафику простой не отличить от работы.
 *
 * Время хранится только в памяти процесса: после перезапуска сервера ответ
 * `null`, и до первого ввода машину держит только нагрузка CPU и агент.
 */
export const MULTICHAMBER_ACTIVITY_ROUTE = '/api/multichamber/activity';

/**
 * Маршрут ставится всегда, чтобы без lockdown запрос получил 404 здесь, а не
 * ушёл в прокси OpenCode.
 * @param {import('express').Express} app
 * @param {{ enabled: boolean, now?: () => number }} options
 */
export const registerMultichamberActivityRoute = (app, { enabled, now = Date.now }) => {
  if (!enabled) {
    const notEnabled = (_req, res) => {
      res.status(404).json({ error: 'activity_not_enabled' });
    };
    app.get(MULTICHAMBER_ACTIVITY_ROUTE, notEnabled);
    app.post(MULTICHAMBER_ACTIVITY_ROUTE, notEnabled);
    return;
  }
  /** @type {number | null} */
  let lastInputAt = null;
  app.post(MULTICHAMBER_ACTIVITY_ROUTE, (_req, res) => {
    lastInputAt = now();
    res.status(204).end();
  });
  app.get(MULTICHAMBER_ACTIVITY_ROUTE, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ last_input_at: lastInputAt === null ? null : new Date(lastInputAt).toISOString() });
  });
};
