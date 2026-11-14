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
