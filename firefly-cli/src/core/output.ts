export type OutputFormat = 'json' | 'raw';

export interface RenderOptions {
  format: OutputFormat;
}

export function renderOutput(data: unknown, options: RenderOptions): string {
  if (options.format === 'raw') {
    return typeof data === 'string' ? data : stringifyJson(data);
  }
  return stringifyJson(data, 2);
}

function stringifyJson(data: unknown, space?: number): string {
  const result = JSON.stringify(data, null, space);
  if (result === undefined) {
    throw new TypeError('Output cannot be represented as JSON.');
  }
  return result;
}
