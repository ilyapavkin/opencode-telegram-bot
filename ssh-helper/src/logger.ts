export function info(message: string): void {
  process.stdout.write(`[SSH helper] ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`[SSH helper] ${message}\n`);
}

export function error(message: string, cause?: unknown): void {
  const detail =
    cause === undefined ? "" : ` ${cause instanceof Error ? cause.message : String(cause)}`;
  process.stderr.write(`[SSH helper] ${message}${detail}\n`);
}
