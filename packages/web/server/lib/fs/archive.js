import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { pipeline } from 'node:stream/promises';

// Каталоги, которые почти всегда восстанавливаются установкой зависимостей или
// сборкой и при этом раздувают архив в десятки раз.
export const ARCHIVE_EXCLUDED_DIRECTORIES = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.svelte-kit',
  '.turbo', '.cache', '.parcel-cache', '.pytest_cache', '.mypy_cache', '.gradle',
]);

// Уже сжатые форматы: deflate тратит CPU и почти ничего не выигрывает.
const STORED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.heic', '.mp4', '.mov', '.webm', '.mp3',
  '.m4a', '.ogg', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.pdf', '.docx', '.xlsx',
  '.pptx', '.woff', '.woff2',
]);

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_FILES = 100_000;
// Ответ check=1 показывается пользователю; сотни путей там бесполезны.
const EXCLUDED_REPORT_LIMIT = 100;

// O_NOFOLLOW: файл, подменённый симлинком после обхода, не открывается.
// O_NONBLOCK: подменённый FIFO не подвешивает open() в ожидании писателя.
const OPEN_FLAGS = nodeFs.constants.O_RDONLY
  | (nodeFs.constants.O_NOFOLLOW ?? 0)
  | (nodeFs.constants.O_NONBLOCK ?? 0);

const positiveInteger = (raw, fallback) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

export const readArchiveLimits = (env = process.env) => ({
  maxBytes: positiveInteger(env.OPENCHAMBER_FS_ARCHIVE_MAX_BYTES, DEFAULT_MAX_BYTES),
  maxFiles: positiveInteger(env.OPENCHAMBER_FS_ARCHIVE_MAX_FILES, DEFAULT_MAX_FILES),
});

const byName = (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

/**
 * Один обход дерева без перехода по симлинкам: считает объём, собирает список файлов
 * и останавливается сразу после превышения лимита, чтобы не обходить огромные деревья зря.
 */
export const measureDirectory = async ({ root, includeExcluded, limits, fsPromises, isAborted }) => {
  const files = [];
  const emptyDirectories = [];
  const excluded = [];
  let bytes = 0;
  let skipped = 0;
  const pending = [''];

  while (pending.length > 0 && !isAborted()) {
    const relativeDirectory = pending.pop();
    const absoluteDirectory = relativeDirectory ? nodePath.join(root, relativeDirectory) : root;
    let dirents;
    try {
      dirents = await fsPromises.readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      if (!relativeDirectory) throw error;
      skipped += 1;
      continue;
    }
    if (dirents.length === 0 && relativeDirectory) {
      emptyDirectories.push(relativeDirectory);
    }

    for (const dirent of dirents.sort(byName)) {
      const relative = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (!includeExcluded && ARCHIVE_EXCLUDED_DIRECTORIES.has(dirent.name)) {
          if (excluded.length < EXCLUDED_REPORT_LIMIT) excluded.push(relative);
          continue;
        }
        pending.push(relative);
        continue;
      }
      // Симлинки, сокеты, FIFO и устройства в архив не попадают.
      if (!dirent.isFile()) continue;

      const absolute = nodePath.join(absoluteDirectory, dirent.name);
      let stats;
      try {
        stats = await fsPromises.lstat(absolute);
      } catch {
        skipped += 1;
        continue;
      }
      if (!stats.isFile()) continue;
      bytes += stats.size;
      files.push({ relative, absolute, size: stats.size, mtime: stats.mtime, mode: stats.mode });
      if (bytes > limits.maxBytes || files.length > limits.maxFiles) {
        return { files, emptyDirectories, excluded, bytes, overLimit: true, skipped };
      }
    }
  }

  return { files, emptyDirectories, excluded, bytes, overLimit: false, skipped };
};

const openRegularFile = async (fsPromises, absolute) => {
  const handle = await fsPromises.open(absolute, OPEN_FLAGS);
  try {
    const stats = await handle.stat();
    if (stats.isFile()) return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  return null;
};

const waitForClose = (stream) => new Promise((resolve) => {
  if (stream.closed) {
    resolve();
    return;
  }
  stream.once('close', resolve);
});

/**
 * Пишет zip в `output`, открывая не больше одного исходного файла за раз:
 * следующий файл открывается только после того, как предыдущий прочитан.
 * Файл, исчезнувший или ставший недоступным до открытия, пропускается.
 * @returns {Promise<{ skipped: number }>}
 */
export const streamDirectoryZip = async ({ rootName, measured, output, fsPromises }) => {
  // Динамический импорт: routes.js обязан загружаться без node_modules рабочего
  // пространства (так его импортирует упакованный desktop), а yazl нужен только здесь.
  const { ZipFile } = await import('yazl');
  const zip = new ZipFile();
  const done = pipeline(zip.outputStream, output);
  // Ошибка уже придёт через `await done`; этот обработчик лишь не даёт ей стать unhandled
  // до того, как цикл ниже до неё дойдёт.
  done.catch(() => undefined);
  zip.on('error', (error) => zip.outputStream.destroy(error));

  let skipped = measured.skipped;
  let current = null;
  output.once('close', () => current?.destroy());

  // yazl бросает синхронно на именах, которые после замены `\` на `/` дают `..`
  // или абсолютный путь; такой файл пропускается, архив продолжается.
  const tryAdd = (add) => {
    try {
      add();
      return true;
    } catch {
      skipped += 1;
      return false;
    }
  };

  for (const directory of measured.emptyDirectories) {
    tryAdd(() => zip.addEmptyDirectory(`${rootName}/${directory}`));
  }

  for (const file of measured.files) {
    if (output.destroyed) break;
    const name = `${rootName}/${file.relative}`;
    const options = {
      mtime: file.mtime,
      mode: file.mode,
      compress: !STORED_EXTENSIONS.has(nodePath.extname(file.relative).toLowerCase()),
    };
    if (file.size === 0) {
      tryAdd(() => zip.addBuffer(Buffer.alloc(0), name, options));
      continue;
    }

    let handle;
    try {
      handle = await openRegularFile(fsPromises, file.absolute);
    } catch {
      handle = null;
    }
    if (handle === null) {
      skipped += 1;
      continue;
    }

    // Читаем не больше размера из обхода: выросший на ходу файл не обойдёт лимит архива.
    const stream = handle.createReadStream({ start: 0, end: file.size - 1 });
    // yazl не слушает 'error' у входного потока; без этого EIO посреди чтения уронил бы процесс.
    // Заголовок записи уже отправлен, поэтому такой архив можно только оборвать.
    stream.once('error', (error) => zip.outputStream.destroy(error));
    if (!tryAdd(() => zip.addReadStreamLazy(name, options, (callback) => callback(null, stream)))) {
      stream.destroy();
      continue;
    }
    current = stream;
    try {
      await Promise.race([waitForClose(stream), done]);
    } finally {
      current = null;
    }
  }

  if (!output.destroyed) zip.end();
  await done;
  return { skipped };
};
