/** Retain meaningful web query parameters while removing known referral tracking. */
export function removeSocialTracking(url: URL): void {
  const host = url.hostname.replace(/^www\./, '').replace(/^twitter\.com$/, 'x.com');
  if (host === 'x.com' || host === 'instagram.com') {
    url.search = '';
  } else {
    for (const name of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(name) || /^(fbclid|gclid|msclkid)$/i.test(name))
        url.searchParams.delete(name);
    }
    url.searchParams.sort();
  }
  url.hash = '';
}
