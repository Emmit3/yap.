const MAX_REFERENCES = 12;
const REFERENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

function isReferenceId(value: unknown): value is string {
  return typeof value === 'string' && REFERENCE_ID.test(value);
}

/** Accept catalog IDs only; the caller resolves them against its trusted catalog. */
export function referenceIdsFromMessage(
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  origin: string,
  frame: MessageEventSource | null,
): string[] | null {
  if (!frame || !origin || origin === 'null' || event.origin !== origin || event.source !== frame)
    return null;

  const data: unknown = event.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const keys = Reflect.ownKeys(data);
  const type = Object.getOwnPropertyDescriptor(data, 'type')?.value;
  const field =
    type === 'yap:film-reference' ? 'filmId' : type === 'yap:film-shortlist' ? 'filmIds' : null;
  if (!field || keys.length !== 2 || !keys.includes('type') || !keys.includes(field)) return null;

  // Data descriptors avoid executing accessors on synthetic or malformed events.
  const value: unknown = Object.getOwnPropertyDescriptor(data, field)?.value;
  if (field === 'filmId') return isReferenceId(value) ? [value] : null;
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = new Set<string>();
  for (const id of value) {
    if (!isReferenceId(id)) return null;
    ids.add(id);
    if (ids.size > MAX_REFERENCES) return null;
  }
  return [...ids];
}

/** Route state is a hash path, with or without its leading '#'. */
export function routePath(route: string): string {
  const path = route.startsWith('#') ? route.slice(1) : route;
  return path.split('?', 1)[0] ?? '';
}

export function referenceIdsFromRoute(route: string): string[] {
  if (routePath(route) !== '/create') return [];
  const queryIndex = route.indexOf('?');
  if (queryIndex === -1) return [];
  const ids = new Set<string>();
  const parameters = new URLSearchParams(route.slice(queryIndex + 1));
  for (const [key, value] of parameters) {
    if (key !== 'reference' || !isReferenceId(value)) continue;
    ids.add(value);
    if (ids.size === MAX_REFERENCES) break;
  }
  return [...ids];
}
