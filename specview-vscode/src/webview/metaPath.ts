/**
 * JSON Pointer (RFC 6901) helpers for metadata field paths. Keys may contain
 * '.' or markup characters, so paths are stored as `/a/b` with `~0`/`~1`
 * escaping instead of dot-joined strings.
 */
export function encodeMetaPathSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function decodeMetaPathSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function joinMetaPath(prefix: string, segment: string): string {
  return prefix + '/' + encodeMetaPathSegment(segment);
}

export function metaPathSegments(path: string): string[] {
  if (!path) return [];
  return path.split('/').slice(1).map(decodeMetaPathSegment);
}

/** Human-readable rendering of a pointer, e.g. `/a/b/0` → `a.b[0]`. */
export function displayMetaPath(path: string): string {
  return metaPathSegments(path).map((segment, index) => {
    if (/^\d+$/.test(segment)) return `[${segment}]`;
    if (/^[A-Za-z_$][\w$]*$/.test(segment)) return index === 0 ? segment : '.' + segment;
    return `[${JSON.stringify(segment)}]`;
  }).join('');
}
