export class AppError extends Error {
  constructor(public code: string, public status: number, message: string, public retryAfterS?: number) { super(message) }
}
export const Errors = {
  invalidRequest: (m = 'invalid request') => new AppError('INVALID_REQUEST', 400, m),
  unauthorized: (m = 'unauthorized') => new AppError('UNAUTHORIZED', 401, m),
  forbidden: (m = 'forbidden') => new AppError('FORBIDDEN', 403, m),
  registrationClosed: () => new AppError('REGISTRATION_CLOSED', 403, 'registration requires REGISTRATION_CODE or ALLOW_OPEN_REGISTRATION=true'),
  policyRejected: (m: string) => new AppError('POLICY_REJECTED', 403, m),
  notFound: (m = 'not found') => new AppError('NOT_FOUND', 404, m),
  conflict: (m: string) => new AppError('CONFLICT', 409, m),
  payloadTooLarge: (m = 'payload too large') => new AppError('PAYLOAD_TOO_LARGE', 413, m),
  unprocessable: (code: string, m: string) => new AppError(code, 422, m),
  rateLimited: (retryAfterS: number) => new AppError('RATE_LIMITED', 429, 'rate limited', retryAfterS),
  internal: (m = 'internal error') => new AppError('INTERNAL', 500, m),
}
