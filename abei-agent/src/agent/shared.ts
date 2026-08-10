/** autofill、回填、词表扫描共用的小工具，别再各写一份。 */

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function trimmed(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = value.trim().slice(0, maxLength);
  return result || undefined;
}

export function isBlank(value: string | undefined): boolean {
  return !value || value.trim() === '';
}

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function prune(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

export function hasNextPage(body: unknown, page: number): boolean {
  const pagination = record(record(record(body)?.meta)?.pagination);
  const totalPages = Number(pagination?.total_pages ?? 1);
  return Number.isFinite(totalPages) && page < totalPages;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
