// Builds the file-naming vocabulary from release data (Module:Codename/data's
// `rel` list) plus the profile's optional overrides: for every release, the
// token used in file names, whether it is version-neutral, and the tokens of
// its versions. Problems in the data are returned as warnings, never hidden.

import type { VocabularyOverrides } from '../profile.ts';

export interface VersionVocab {
  /** Key in the data's `versions` table, e.g. "advance". */
  readonly key: string;
  readonly name: string;
  /** Token in file names, e.g. "GBA". */
  readonly token: string;
  readonly tokenFrom: TokenSource;
}

export interface ReleaseVocab {
  readonly id: string;
  /** Full title, for category names: "Final Fantasy VII". */
  readonly title: string;
  /** Token in file names: "FFVII Remake". */
  readonly token: string;
  readonly tokenFrom: TokenSource;
  /** Codename of the parent release (`sub`), if any. */
  readonly parent: string | undefined;
  /** File names for this release never carry a version. */
  readonly versionNeutral: boolean;
  readonly versions: readonly VersionVocab[];
}

/** Where a token came from: the profile, `files.shorthand`, or the default (`id` / `name`). */
export type TokenSource = 'profile' | 'shorthand' | 'default';

export type WarningCode =
  | 'invalid-release'
  | 'versions-not-keyed'
  | 'bad-token'
  | 'duplicate-token'
  | 'ambiguous-token'
  | 'unknown-override'
  | 'override-disagrees'
  | 'override-redundant';

export interface VocabularyWarning {
  readonly code: WarningCode;
  readonly release: string;
  readonly version?: string;
  readonly message: string;
}

export interface Vocabulary {
  readonly releases: readonly ReleaseVocab[];
  readonly byId: ReadonlyMap<string, ReleaseVocab>;
  readonly byToken: ReadonlyMap<string, ReleaseVocab>;
  readonly warnings: readonly VocabularyWarning[];
}

interface FilesField {
  shorthand?: unknown;
  versionneutral?: unknown;
}

/** `data` is the parsed Module:Codename/data (from the export or the Lua). */
export function buildVocabulary(data: unknown, overrides: VocabularyOverrides): Vocabulary {
  const warnings: VocabularyWarning[] = [];
  const warn = (code: WarningCode, release: string, message: string, version?: string) =>
    warnings.push(version === undefined ? { code, release, message } : { code, release, version, message });

  const rel = (data as { rel?: unknown } | null)?.rel;
  if (!Array.isArray(rel)) {
    throw new Error('release data has no `rel` list');
  }

  const releases: ReleaseVocab[] = [];
  for (const [index, entry] of rel.entries()) {
    const release = asRecord(entry);
    const id = release?.id;
    const title = release?.title;
    if (release === undefined || typeof id !== 'string' || typeof title !== 'string') {
      warn('invalid-release', `rel[${index}]`, 'entry has no string `id` and `title`; skipped');
      continue;
    }
    const files = (asRecord(release.files) ?? {}) as FilesField;

    const token = pickToken(id, overrides.releaseTokens[id], files.shorthand, id, warn);
    const neutralInData = files.versionneutral === true;
    const neutralInProfile = overrides.versionNeutral.includes(id);
    if (neutralInData && neutralInProfile) {
      warn('override-redundant', id, 'profile lists it as version-neutral, and so does the data');
    }

    releases.push({
      id,
      title,
      token: token.value,
      tokenFrom: token.from,
      parent: firstParent(release.sub),
      versionNeutral: neutralInData || neutralInProfile,
      versions: buildVersions(id, release.versions, overrides.versionTokens[id] ?? {}, warn),
    });
  }

  const byId = new Map(releases.map((release) => [release.id, release]));
  for (const release of Object.keys(overrides.releaseTokens)) {
    if (!byId.has(release)) warn('unknown-override', release, 'profile sets a release token for a release not in the data');
  }
  for (const release of Object.keys(overrides.versionTokens)) {
    if (!byId.has(release)) warn('unknown-override', release, 'profile sets version tokens for a release not in the data');
  }
  for (const release of overrides.versionNeutral) {
    if (!byId.has(release)) warn('unknown-override', release, 'profile lists a version-neutral release not in the data');
  }

  checkTokens(releases, warn);

  const byToken = new Map<string, ReleaseVocab>();
  for (const release of releases) {
    if (!byToken.has(release.token)) byToken.set(release.token, release);
  }
  return { releases, byId, byToken, warnings };
}

type Warn = (code: WarningCode, release: string, message: string, version?: string) => void;

function buildVersions(id: string, versions: unknown, overrides: Readonly<Record<string, string>>, warn: Warn): VersionVocab[] {
  if (versions === undefined && Object.keys(overrides).length === 0) {
    return [];
  }
  if (Array.isArray(versions) || (versions !== undefined && !isKeyedVersions(versions))) {
    warn('versions-not-keyed', id, '`versions` is not a table of keyed version tables; its versions are ignored');
    return [];
  }

  const table = (asRecord(versions) ?? {}) as Record<string, Record<string, unknown>>;
  const result: VersionVocab[] = [];
  for (const [key, version] of Object.entries(table)) {
    const name = typeof version.name === 'string' ? version.name : '';
    const files = (asRecord(version.files) ?? {}) as FilesField;
    const token = pickToken(id, overrides[key], files.shorthand, name, warn, key);
    result.push({ key, name, token: token.value, tokenFrom: token.from });
  }
  // A profile override for a version the data lacks adds that version.
  for (const [key, token] of Object.entries(overrides)) {
    if (!(key in table)) result.push({ key, name: token, token, tokenFrom: 'profile' });
  }
  return result;
}

/** Profile override > `files.shorthand` > default, warning when the first two overlap. */
function pickToken(
  release: string,
  override: string | undefined,
  shorthand: unknown,
  fallback: string,
  warn: Warn,
  version?: string,
): { value: string; from: TokenSource } {
  const fromData = typeof shorthand === 'string' ? shorthand : undefined;
  if (override !== undefined) {
    if (fromData === override) {
      warn('override-redundant', release, `profile token "${override}" is the same as the data's files.shorthand`, version);
    } else if (fromData !== undefined) {
      warn('override-disagrees', release, `profile token "${override}" overrides the data's files.shorthand "${fromData}"`, version);
    }
    return { value: override, from: 'profile' };
  }
  if (fromData !== undefined) {
    return { value: fromData, from: 'shorthand' };
  }
  return { value: fallback, from: 'default' };
}

/** Characters MediaWiki doesn't allow in titles. */
const ILLEGAL_TITLE_CHARS = /[#<>[\]|{}]/;

function checkTokens(releases: readonly ReleaseVocab[], warn: Warn): void {
  const releaseTokens = new Map<string, string>();
  for (const release of releases) {
    const problem = tokenProblem(release.token);
    if (problem !== undefined) warn('bad-token', release.id, `release token "${release.token}" ${problem}`);

    const other = releaseTokens.get(release.token);
    if (other !== undefined) {
      warn('duplicate-token', release.id, `release token "${release.token}" is also used by ${other}`);
    } else {
      releaseTokens.set(release.token, release.id);
    }

    // Versions of a version-neutral release never appear in file names.
    if (release.versionNeutral) continue;
    for (const version of release.versions) {
      const versionProblem = tokenProblem(version.token);
      if (versionProblem !== undefined) {
        warn('bad-token', release.id, `version token "${version.token}" ${versionProblem}`, version.key);
      }
    }
  }

  // "<release> <version>" must not read as another release's token, or a
  // file name would have two readings.
  for (const release of releases) {
    if (release.versionNeutral) continue;
    for (const version of release.versions) {
      const combined = `${release.token} ${version.token}`;
      const other = releaseTokens.get(combined);
      if (other !== undefined && other !== release.id) {
        warn('ambiguous-token', release.id, `"${combined}" (release + version) is also the release token of ${other}`, version.key);
      }
    }
  }
}

function tokenProblem(token: string): string | undefined {
  if (token.trim() === '') return 'is empty';
  if (token !== token.trim()) return 'has leading or trailing spaces';
  if (/^\(.*\)$/.test(token)) return 'is wrapped in parentheses';
  if (/(^| )from( |$)/.test(token)) return 'contains the word "from", which the file-name grammar uses as a separator';
  if (ILLEGAL_TITLE_CHARS.test(token)) return 'contains a character MediaWiki forbids in titles';
  return undefined;
}

function isKeyedVersions(value: unknown): boolean {
  const table = asRecord(value);
  return table !== undefined && Object.values(table).every((version) => asRecord(version) !== undefined);
}

/**
 * `sub` is a codename or a comma-separated list of them. XIV1 has the string
 * 'false', which Module:Codename never matches as a parent, so it means none.
 */
function firstParent(sub: unknown): string | undefined {
  if (typeof sub !== 'string') return undefined;
  const first = sub.split(',')[0]?.trim();
  return first === '' || first === 'false' ? undefined : first;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
