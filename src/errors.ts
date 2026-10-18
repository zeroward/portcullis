export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    message = code,
  ) {
    super(message);
  }
}
export function invariant(
  condition: unknown,
  code: string,
  status = 400,
): asserts condition {
  if (!condition) throw new AppError(code, status);
}
