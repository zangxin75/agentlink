export class AppError extends Error {
  constructor(public code: string, public status: number, message: string, public retryAfterS?: number) { super(message) }
}
export const Errors = {
  invalidRequest: (m = 'invalid request') => new AppError('INVALID_REQUEST', 400, m),
  badRequest: (code: string, m: string) => new AppError(code, 400, m),
  unauthorized: (m = 'unauthorized') => new AppError('UNAUTHORIZED', 401, m),
  forbidden: (m = 'forbidden') => new AppError('FORBIDDEN', 403, m),
  registrationClosed: () => new AppError('REGISTRATION_CLOSED', 403, 'registration requires REGISTRATION_CODE or ALLOW_OPEN_REGISTRATION=true'),
  policyRejected: (m: string) => new AppError('POLICY_REJECTED', 403, m),
  notFound: (m = 'not found') => new AppError('NOT_FOUND', 404, m),
  gone: (m = 'gone') => new AppError('GONE', 410, m),
  conflict: (m: string) => new AppError('CONFLICT', 409, m),
  payloadTooLarge: (m = 'payload too large') => new AppError('PAYLOAD_TOO_LARGE', 413, m),
  unprocessable: (code: string, m: string) => new AppError(code, 422, m),
  quotaExceeded: (m = 'file quota exceeded') => new AppError('QUOTA_EXCEEDED', 403, m),
  insufficientStorage: (m = 'insufficient storage') => new AppError('INSUFFICIENT_STORAGE', 507, m),
  fileUploadInProgress: (m = 'upload already in progress') => new AppError('FILE_UPLOAD_IN_PROGRESS', 409, m),
  rateLimited: (retryAfterS: number) => new AppError('RATE_LIMITED', 429, 'rate limited', retryAfterS),
  internal: (m = 'internal error') => new AppError('INTERNAL', 500, m),
  smtpNotConfigured: () => new AppError('SMTP_NOT_CONFIGURED', 503, 'self-service regcode disabled: SMTP not configured'),
  agentIdTaken: () => new AppError('AGENT_ID_TAKEN', 409, 'human_agent_id already taken'), // r1-C1：verify 占用复查须 409，非 400
}
