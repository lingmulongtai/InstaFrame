import { createHash } from 'node:crypto';

const LOCAL_ASSET_PROTOCOL = /^(?:[a-z]+:|\/\/|#|data:|blob:)/i;

export function createContentRevision(entries) {
  const hash = createHash('sha256');
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path.replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(entry.content);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

export function normalizeReleaseRevision(value) {
  const revision = String(value || '').trim();
  return /^[a-f0-9]{7,64}$/i.test(revision) ? revision.slice(0, 12).toLowerCase() : '';
}

export function versionLocalAsset(reference, revision) {
  const value = String(reference || '');
  if (!revision || !value || LOCAL_ASSET_PROTOCOL.test(value) || value.startsWith('/')) return value;
  const [withoutFragment, fragment = ''] = value.split('#', 2);
  const separator = withoutFragment.includes('?') ? '&' : '?';
  return `${withoutFragment}${separator}v=${revision}${fragment ? `#${fragment}` : ''}`;
}

export function rewriteHtmlAssetReferences(html, revision) {
  return html.replace(/\b(src|href)=(['"])([^'"]+)\2/g, (match, attribute, quote, reference) => {
    const versioned = versionLocalAsset(reference, revision);
    return `${attribute}=${quote}${versioned}${quote}`;
  });
}
