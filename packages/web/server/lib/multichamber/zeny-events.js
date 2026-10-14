import { z } from 'zod';

const TIMEOUT_MS = 5000;
const WARN_COOLDOWN_MS = 60 * 1000;
const MAX_MESSAGE_CHARS = 2000;

const nonEmptyString = z.string().trim().min(1);

const parseHttpUrl = (value) => {
  const parsed = nonEmptyString.safeParse(value);
  if (!parsed.success) return null;
  try {
    const url = new URL(parsed.data);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

const rawProjectSchema = z.object({
  id: nonEmptyString,
  path: nonEmptyString,
  label: z.string().trim().optional(),
});

const normalizeProjects = (projects) => {
  if (!Array.isArray(projects)) return [];
  const result = [];
  for (const item of projects) {
    const parsed = rawProjectSchema.safeParse(item);
    if (!parsed.success) continue;
    const { id, path, label } = parsed.data;
    const finalLabel = label || path.split('/').filter(Boolean).pop() || id;
    result.push({ id, label: finalLabel, path });
  }
  return result;
};

const matchProject = (projects, directory, projectName) => {
  const dirParsed = nonEmptyString.safeParse(directory);
  if (dirParsed.success) {
    const dir = dirParsed.data.replace(/\/+$/, '');
    const byPath = projects.find((p) => {
      const base = p.path.replace(/\/+$/, '');
      return dir === base || dir.startsWith(`${base}/`);
    });
    if (byPath) return byPath;
  }
  const nameParsed = nonEmptyString.safeParse(projectName);
  if (nameParsed.success) {
    const name = nameParsed.data.toLowerCase();
    const byLabel = projects.find((p) => p.label.toLowerCase() === name);
    if (byLabel) return byLabel;
  }
  return null;
};

const notificationPayloadSchema = z.object({
  body: z.string().optional(),
  data: z
    .object({
      sessionId: nonEmptyString,
      sessionName: z.string().optional(),
      type: nonEmptyString,
    })
    .optional(),
  zeny: z
    .object({
      eventId: z.string().optional(),
      directory: z.string().nullish(),
      projectName: z.string().nullish(),
      message: z.string().nullish(),
    })
    .optional(),
});

export const createZenyEventsClient = ({
  env = process.env,
  fetchImpl = fetch,
  readSettings = null,
  warn = (line) => console.warn(line),
  now = () => Date.now(),
} = {}) => {
  const raw = env?.MULTICHAMBER_ZENY_EVENTS_URL;
  const rawStr = nonEmptyString.safeParse(raw);
  if (!rawStr.success) return null;
  const url = parseHttpUrl(rawStr.data);
  if (!url) {
    warn('[multichamber] ignoring invalid MULTICHAMBER_ZENY_EVENTS_URL');
    return null;
  }

  let lastWarnAt = -WARN_COOLDOWN_MS;
  const warnOnce = (reason) => {
    const t = now();
    if (t - lastWarnAt < WARN_COOLDOWN_MS) return;
    lastWarnAt = t;
    warn(`[multichamber] zeny events delivery failed (${reason})`);
  };

  const post = async (body) => {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) warnOnce(`status ${res.status}`);
    } catch (error) {
      warnOnce(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network error');
    }
  };

  const readNormalizedProjects = async () => {
    if (!readSettings) return [];
    try {
      const settings = await readSettings();
      return normalizeProjects(settings?.projects);
    } catch {
      return [];
    }
  };

  const sendProjects = async (projectsInput) => {
    const projects = Array.isArray(projectsInput) ? normalizeProjects(projectsInput) : await readNormalizedProjects();
    await post({ kind: 'projects', projects });
  };

  const sendFromNotification = async (payload) => {
    const parsed = notificationPayloadSchema.safeParse(payload);
    if (!parsed.success || !parsed.data.data) return;

    const { data, zeny = {}, body } = parsed.data;
    const { sessionId, type } = data;
    const eventId = nonEmptyString.safeParse(zeny.eventId).data ?? `${type}:${sessionId}:${now()}`;
    const sessionName = nonEmptyString.safeParse(data.sessionName).data ?? '';
    const directory = nonEmptyString.safeParse(zeny.directory).data ?? null;
    const rawMessage = nonEmptyString.safeParse(zeny.message).data ?? nonEmptyString.safeParse(body).data ?? '';
    const message = rawMessage.slice(0, MAX_MESSAGE_CHARS);

    const projects = await readNormalizedProjects();
    const project = matchProject(projects, directory, zeny.projectName);

    await post({
      kind: 'session',
      eventId,
      type,
      sessionId,
      sessionName,
      directory,
      project,
      message,
      projects,
    });
  };

  return {
    url,
    sendProjects,
    sendFromNotification,
  };
};
