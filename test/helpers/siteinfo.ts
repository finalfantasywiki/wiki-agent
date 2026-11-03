// A minimal meta=siteinfo response (general|namespaces|namespacealiases) for
// a standard English MediaWiki, so mwn's Title can normalize titles offline.

import type { FakeWiki } from './fake-wiki.ts';

const ns = (id: number, name: string, canonical = name) => ({ id, name, canonical, case: 'first-letter' });

export const SITEINFO = {
  query: {
    general: { legaltitlechars: " %!\"$&'()*,\\-.\\/0-9:;=?@A-Z\\\\^_`a-z~\\x80-\\xFF+" },
    namespaces: {
      '-2': ns(-2, 'Media'),
      '-1': ns(-1, 'Special'),
      '0': ns(0, ''),
      '1': ns(1, 'Talk'),
      '2': ns(2, 'User'),
      '6': ns(6, 'File'),
      '10': ns(10, 'Template'),
      '14': ns(14, 'Category'),
      '828': ns(828, 'Module'),
    },
    namespacealiases: [{ id: 6, alias: 'Image' }],
  },
};

/** Loads SITEINFO into the client, as `await client.getSiteInfo()` would from the wiki. */
export function loadSiteInfo(client: FakeWiki): void {
  client.Title.processNamespaceData(SITEINFO);
}
