export type FilesystemErrorReason =
  | 'os-permission'
  | 'already-exists'
  | 'not-found'
  | 'not-directory'
  | 'invalid-response'
  | 'file_too_large'
  | 'insufficient_storage'
  | 'archive_too_large'
  | 'archive_busy'
  | 'unknown';

export interface FilesystemErrorOptions {
  reason?: FilesystemErrorReason;
  status?: number;
  // Числа из тела ответа сервера: лимит тарифа и размер, чтобы UI назвал их пользователю.
  limit?: number;
  bytes?: number;
  free?: number;
  required?: number;
}

export class FilesystemError extends Error {
  readonly reason: FilesystemErrorReason;
  readonly status?: number;
  readonly limit?: number;
  readonly bytes?: number;
  readonly free?: number;
  readonly required?: number;

  constructor(message: string, options: FilesystemErrorOptions = {}) {
    super(message);
    this.name = 'FilesystemError';
    this.reason = options.reason ?? 'unknown';
    this.status = options.status;
    this.limit = options.limit;
    this.bytes = options.bytes;
    this.free = options.free;
    this.required = options.required;
  }
}

export const isFilesystemError = (error: unknown): error is FilesystemError => (
  error instanceof FilesystemError
  || Boolean(
    error
    && typeof error === 'object'
    && 'reason' in error
    && typeof (error as { reason?: unknown }).reason === 'string'
  )
);

export const parseFilesystemErrorReason = (value: unknown): FilesystemErrorReason => {
  switch (value) {
    case 'os-permission':
    case 'already-exists':
    case 'not-found':
    case 'not-directory':
    case 'invalid-response':
    case 'file_too_large':
    case 'insufficient_storage':
    case 'archive_too_large':
    case 'archive_busy':
      return value;
    default:
      return 'unknown';
  }
};

const finiteNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

// Собирает FilesystemError из JSON-тела ошибки сервера, сохраняя reason и числовые поля.
export const filesystemErrorFromPayload = (
  payload: unknown,
  status: number,
  fallbackMessage: string,
): FilesystemError => {
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const message = typeof body.error === 'string' && body.error ? body.error : fallbackMessage;
  return new FilesystemError(message, {
    reason: parseFilesystemErrorReason(body.reason),
    status,
    limit: finiteNumber(body.limit),
    bytes: finiteNumber(body.bytes),
    free: finiteNumber(body.free),
    required: finiteNumber(body.required),
  });
};
