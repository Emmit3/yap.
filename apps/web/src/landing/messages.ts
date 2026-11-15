/** An optional public build setting can open a prepared creation from the landing page. */
export function exampleCreationPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? `/create/${id}`
    : null;
}

export function destinationForShowcaseMessage(
  event: { origin: string; source: unknown; data: unknown },
  expectedOrigin: string,
  expectedSource: unknown | null,
): 'studio' | 'social' | 'inspiration' | null {
  if (
    expectedSource === null ||
    expectedSource === undefined ||
    event.origin !== expectedOrigin ||
    event.source !== expectedSource
  ) {
    return null;
  }

  const data = event.data;
  if (
    typeof data !== 'object' ||
    data === null ||
    Array.isArray(data) ||
    !('type' in data) ||
    !Object.hasOwn(data, 'type')
  ) {
    return null;
  }

  if (data.type === 'yap:enter-studio') return 'studio';
  if (data.type === 'yap:open-social') return 'social';
  if (data.type === 'yap:open-inspiration') return 'inspiration';
  return null;
}
