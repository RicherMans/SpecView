export interface LazySourceDescriptor {
  name: string;
  filePath: string;
  sourceId: string;
  generation: number;
  // Temporary compatibility for the current webview. It treats this opaque ID
  // as a URI, but the extension host never parses it as one.
  uri: string;
}

export interface FileDataRequest {
  sourceId: string;
  requestId?: string;
  generation?: number;
}

export function parseFileDataRequest(message: unknown): FileDataRequest | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const value = message as Record<string, unknown>;
  const modern = typeof value.sourceId === 'string';
  const sourceId = modern ? value.sourceId as string : typeof value.uri === 'string' ? value.uri : undefined;
  if (!sourceId || sourceId.length > 256) return undefined;
  if (value.requestId !== undefined && typeof value.requestId !== 'string') return undefined;
  if (value.generation !== undefined && (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0)) return undefined;
  if (modern && (
    typeof value.requestId !== 'string' || value.requestId.length === 0 || value.requestId.length > 256
  )) return undefined;
  return {
    sourceId,
    requestId: value.requestId as string | undefined,
    generation: value.generation as number | undefined,
  };
}

export function lazySourceDescriptor(
  name: string,
  filePath: string,
  sourceId: string,
  generation: number,
): LazySourceDescriptor {
  return { name, filePath, sourceId, generation, uri: sourceId };
}
