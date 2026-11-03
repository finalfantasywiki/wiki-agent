// Loads a profile's release vocabulary from the wiki: from the export module
// (one call to the wiki's own Lua) or by parsing the Lua data, as the profile
// says, optionally cross-checking one against the other. The result is the
// naming rules every file-name check uses.

import type { Profile } from '../profile.ts';
import { crossCheck, fromExport, fromLua, type Difference } from '../sources/codename.ts';
import type { WikiClient } from '../wiki/client.ts';
import type { NamingRules } from './file-name.ts';
import { buildVocabulary } from './vocabulary.ts';

export interface LoadedRules {
  readonly rules: NamingRules;
  /** Where the data that was used came from. */
  readonly source: Profile['releases']['source'];
  /** Where the export and the parsed Lua disagree; empty without a cross-check. */
  readonly differences: readonly Difference[];
}

export async function loadNamingRules(client: WikiClient, profile: Profile): Promise<LoadedRules> {
  const { releases } = profile;
  const exported = releases.source === 'export-module' || releases.crossCheck ? await fromExport(client, releases.exportModule) : undefined;
  const parsed = releases.source === 'parse-lua' || releases.crossCheck ? await fromLua(client, releases.dataModule) : undefined;
  const data = releases.source === 'export-module' ? exported : parsed;
  return {
    rules: { vocabulary: buildVocabulary(data, profile.vocabulary), types: profile.fileNaming.types },
    source: releases.source,
    differences: releases.crossCheck ? crossCheck(exported, parsed) : [],
  };
}
