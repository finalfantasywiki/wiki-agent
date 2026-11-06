// The file-name grammar (docs/design.md, "File naming convention"):
//
//   Standard:  <Subject> from <Release>[ <Version>] <Type>[ <N>].<ext>
//   Quest:     <Quest or chapter> from <Release>[ <Version>][ <N>].<ext>
//   Titled:    <Release title>[ <more>] <Type>[ <N>].<ext>
//
// The titled form is for subjects that are themselves a release missing from
// the vocabulary, such as "Final Fantasy VII Technical Demo for PS3 still.jpg":
// the name already says what it's from. It's only tried for names without
// " from ", and it always warns, so it isn't used to dodge the grammar.
//
// parseFileName finds every reading of a name against the vocabulary;
// validateFileName also applies the naming rules and explains failures, so
// the LLM proposing names can correct them; formatFileName builds a name from
// its parts.

import type { ReleaseVocab, VersionVocab, Vocabulary } from './vocabulary.ts';

export interface FileNameParts {
  readonly form: 'standard' | 'quest' | 'titled';
  /** The subject, or the quest/chapter name in the quest form; in the titled form, everything before the type. */
  readonly subject: string;
  /** In the titled form, the release whose title the subject starts with. */
  readonly release: ReleaseVocab;
  readonly version: VersionVocab | undefined;
  /** The type as written, e.g. "battle render"; undefined in the quest form, and only the known type in the titled form. */
  readonly type: string | undefined;
  /** The known type it ends with, e.g. "render". */
  readonly baseType: string | undefined;
  /** The disambiguating number (1 or more) of a numbered set, if any. */
  readonly number: number | undefined;
  readonly extension: string;
}

export type IssueCode =
  | 'not-parsed'
  | 'ambiguous'
  | 'bad-characters'
  | 'bad-spacing'
  | 'too-long'
  | 'bad-number'
  | 'version-not-allowed'
  | 'version-missing'
  | 'type-looks-like-version'
  | 'titled-form'
  | 'extension-changed';

export interface Issue {
  readonly code: IssueCode;
  readonly message: string;
}

export interface Validation {
  /** True when there are no errors (warnings are allowed). */
  readonly ok: boolean;
  /** The single reading, when there is exactly one. */
  readonly parts: FileNameParts | undefined;
  readonly errors: readonly Issue[];
  readonly warnings: readonly Issue[];
}

export interface NamingRules {
  readonly vocabulary: Vocabulary;
  /** Known base types, e.g. ["render", "gameplay", "concept art"]. */
  readonly types: readonly string[];
}

/** MediaWiki's limit for file names, in bytes. */
const MAX_FILE_NAME_BYTES = 240;
/** Characters MediaWiki doesn't allow in titles. */
const ILLEGAL_TITLE_CHARS = /[#<>[\]|{}]/;
const SEPARATOR = ' from ';

/** Strips a `File:` prefix and turns underscores into spaces, as MediaWiki does. */
export function normalizeFileName(name: string): string {
  return name.replace(/^(File|Image):/i, '').replaceAll('_', ' ');
}

/** Every way `name` can be read against the grammar (usually zero or one). */
export function parseFileName(name: string, rules: NamingRules): FileNameParts[] {
  return parse(normalizeFileName(name), rules).readings;
}

export function validateFileName(name: string, rules: NamingRules, options: { originalExtension?: string } = {}): Validation {
  const normalized = normalizeFileName(name);
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  if (ILLEGAL_TITLE_CHARS.test(normalized)) {
    errors.push({ code: 'bad-characters', message: 'contains a character MediaWiki forbids in titles (# < > [ ] | { })' });
  }
  if (normalized !== normalized.trim() || normalized.includes('  ')) {
    errors.push({ code: 'bad-spacing', message: 'has leading, trailing or double spaces' });
  }
  if (Buffer.byteLength(normalized, 'utf8') > MAX_FILE_NAME_BYTES) {
    errors.push({ code: 'too-long', message: `is longer than ${MAX_FILE_NAME_BYTES} bytes` });
  }

  const { readings, failures } = parse(normalized, rules);
  if (readings.length === 0) {
    errors.push({ code: 'not-parsed', message: explain(failures) });
  } else if (readings.length > 1) {
    errors.push({ code: 'ambiguous', message: `can be read ${readings.length} ways: ${readings.map(describe).join('; ')}` });
  }

  const parts = readings.length === 1 ? readings[0] : undefined;
  if (parts?.form === 'titled') {
    warnings.push({
      code: 'titled-form',
      message: `has no " from <release>" part; that's only right when "${parts.subject}" is itself a release missing from the vocabulary (e.g. a tech demo), otherwise write "<Subject> from ${parts.release.token} ${parts.type}"`,
    });
  } else if (parts !== undefined) {
    if (parts.version !== undefined && parts.release.versionNeutral) {
      errors.push({
        code: 'version-not-allowed',
        message: `${parts.release.token} is version-neutral, so its file names don't take a version (found "${parts.version.token}")`,
      });
    }
    // "PS render" on a release with no PS version: probably a version, not a
    // more specific type.
    const qualifier = parts.type !== undefined && parts.type !== parts.baseType ? parts.type.slice(0, -(parts.baseType?.length ?? 0)).trimEnd() : '';
    const versionLike = allVersionTokens(rules.vocabulary).find((token) => startsWithWord(qualifier, token));
    if (versionLike !== undefined) {
      warnings.push({
        code: 'type-looks-like-version',
        message: parts.release.versionNeutral
          ? `"${versionLike}" in the type "${parts.type}" looks like a version, but ${parts.release.token} is version-neutral; drop it`
          : `"${versionLike}" in the type "${parts.type}" looks like a version, but ${parts.release.token} has no such version (${versionList(parts.release)})`,
      });
    }
    if (parts.version === undefined && !parts.release.versionNeutral && parts.release.versions.length > 0) {
      const tokens = [...new Set(parts.release.versions.map((version) => version.token))];
      warnings.push({
        code: 'version-missing',
        message: `${parts.release.token} has versions (${tokens.join(', ')}); add one if the image is from a specific version`,
      });
    }
  }

  if (options.originalExtension !== undefined) {
    const original = canonicalExtension(options.originalExtension);
    const extension = canonicalExtension(normalized.slice(normalized.lastIndexOf('.') + 1));
    if (original !== extension) {
      errors.push({
        code: 'extension-changed',
        message: `changes the extension from .${options.originalExtension} (MediaWiki rejects moves that change the file type)`,
      });
    }
  }

  return { ok: errors.length === 0, parts, errors, warnings };
}

/** Builds a name from its parts: the inverse of parseFileName. With no release, it builds the titled form. */
export function formatFileName(parts: {
  readonly subject: string;
  readonly release?: string | undefined;
  readonly version?: string | undefined;
  readonly type?: string | undefined;
  readonly number?: number | undefined;
  readonly extension: string;
}): string {
  const from = parts.release === undefined ? [] : ['from', parts.release];
  const words = [parts.subject, ...from, parts.version, parts.type, parts.number?.toString()];
  return `${words.filter((word) => word !== undefined && word !== '').join(' ')}.${parts.extension}`;
}

// --- Parsing ------------------------------------------------------------------

/** Why one attempt failed; the attempt that got furthest explains the failure. */
interface Failure {
  readonly progress: number;
  readonly message: string;
}

function parse(name: string, rules: NamingRules): { readings: FileNameParts[]; failures: Failure[] } {
  const readings: FileNameParts[] = [];
  const failures: Failure[] = [];

  const dot = name.lastIndexOf('.');
  const extension = name.slice(dot + 1);
  if (dot <= 0 || extension === '' || extension.includes(' ')) {
    failures.push({ progress: 0, message: 'has no file extension' });
    return { readings, failures };
  }
  const stem = name.slice(0, dot);

  // Try each " from " as the separator; the subject itself may contain "from".
  let at = stem.indexOf(SEPARATOR);
  if (at === -1) {
    failures.push({ progress: 0, message: `has no " from <release>" part` });
  }
  for (; at !== -1; at = stem.indexOf(SEPARATOR, at + 1)) {
    const subject = stem.slice(0, at);
    const rest = stem.slice(at + SEPARATOR.length);
    if (subject === '') {
      failures.push({ progress: 1, message: 'has no subject before "from"' });
      continue;
    }
    // Longest release token first, and the first that reads wins: "FFVII
    // Remake concept art" is FFVIIR + "concept art", not FFVII + "Remake
    // concept art".
    const releases = [...rules.vocabulary.byToken.values()]
      .filter((release) => startsWithWord(rest, release.token))
      .sort((a, b) => b.token.length - a.token.length);
    if (releases.length === 0) {
      failures.push({ progress: 1, message: `doesn't name a known release after "from" (found "${rest}")` });
      continue;
    }
    for (const release of releases) {
      const before = readings.length;
      readAfterRelease(subject, release, rest.slice(release.token.length).trimStart(), extension, rules, readings, failures);
      if (readings.length > before) break;
    }
  }
  // A name with " from " is never titled, so a mistyped release still fails.
  if (!stem.includes(SEPARATOR)) readTitled(stem, extension, rules, readings, failures);
  return { readings, failures };
}

/** Reads `<Release title>[ <more>] <Type>[ <N>]`: the longest release title the stem starts with. */
function readTitled(stem: string, extension: string, rules: NamingRules, readings: FileNameParts[], failures: Failure[]): void {
  const release = rules.vocabulary.releases
    .filter((candidate) => startsWithWord(stem, candidate.title))
    .sort((a, b) => b.title.length - a.title.length)[0];
  if (release === undefined) return;

  const numberMatch = / (\d+)$/.exec(stem);
  const numberText = numberMatch?.[1];
  if (numberText !== undefined && numberText.startsWith('0')) {
    failures.push({ progress: 3, message: `ends in "${numberText}"; a numbered set starts at 1, with no leading zeros` });
    return;
  }
  const middle = numberMatch === null ? stem : stem.slice(0, numberMatch.index);
  const type = rules.types.find((candidate) => middle.endsWith(` ${candidate}`));
  if (type === undefined) {
    failures.push({
      progress: 1,
      message: `starts with the title "${release.title}" but has no " from <release>" part, and doesn't end in a type (${rules.types.map((candidate) => `"${candidate}"`).join(', ')})`,
    });
    return;
  }
  const subject = middle.slice(0, -type.length - 1);
  readings.push({
    form: 'titled',
    subject,
    release,
    version: undefined,
    type,
    baseType: type,
    number: numberText === undefined ? undefined : Number(numberText),
    extension,
  });
}

/** Reads `[<Version>] [<Type>] [<N>]` after the release token. */
function readAfterRelease(
  subject: string,
  release: ReleaseVocab,
  rest: string,
  extension: string,
  rules: NamingRules,
  readings: FileNameParts[],
  failures: Failure[],
): void {
  const numberMatch = /(?:^| )(\d+)$/.exec(rest);
  const numberText = numberMatch?.[1];
  const middle = numberMatch === null ? rest : rest.slice(0, numberMatch.index).trimEnd();
  if (numberText !== undefined && numberText.startsWith('0')) {
    failures.push({ progress: 3, message: `ends in "${numberText}"; a numbered set starts at 1, with no leading zeros` });
    return;
  }
  const number = numberText === undefined ? undefined : Number(numberText);

  // Version: any version token the middle starts with, else none. A version
  // reading wins, so "FFVI Pixel Remaster render" is version "Pixel Remaster"
  // + type "render", never the "specific type" "Pixel Remaster render".
  const versions = release.versions.filter(
    (version, index, all) => startsWithWord(middle, version.token) && all.findIndex((other) => other.token === version.token) === index,
  );
  const read = (version: VersionVocab | undefined): FileNameParts | undefined => {
    const afterVersion = version === undefined ? middle : middle.slice(version.token.length).trimStart();
    if (afterVersion === '') {
      return { form: 'quest', subject, release, version, type: undefined, baseType: undefined, number, extension };
    }
    const baseType = rules.types.find((type) => afterVersion === type || afterVersion.endsWith(` ${type}`));
    return baseType === undefined ? undefined : { form: 'standard', subject, release, version, type: afterVersion, baseType, number, extension };
  };
  let found = versions.map(read).filter((reading) => reading !== undefined);
  if (found.length === 0) {
    const reading = read(undefined);
    found = reading === undefined ? [] : [reading];
  }
  readings.push(...found);
  if (found.length === 0) {
    const hint = rules.types.find((type) => middle.toLowerCase().endsWith(type));
    failures.push({
      progress: 2,
      message:
        hint !== undefined
          ? `the type must be written in lowercase, e.g. "${hint}" (found "${middle}")`
          : `after "${release.token}", expected an optional version (${versionList(release)}) and then a type ending in ${rules.types.map((type) => `"${type}"`).join(', ')}, or nothing for a quest name (found "${middle}")`,
    });
  }
}

const versionTokenCache = new WeakMap<Vocabulary, string[]>();

/** Every version token in the vocabulary, longest first. */
function allVersionTokens(vocabulary: Vocabulary): string[] {
  let tokens = versionTokenCache.get(vocabulary);
  if (tokens === undefined) {
    tokens = [...new Set(vocabulary.releases.flatMap((release) => release.versions.map((version) => version.token)))];
    tokens.sort((a, b) => b.length - a.length);
    versionTokenCache.set(vocabulary, tokens);
  }
  return tokens;
}

function versionList(release: ReleaseVocab): string {
  if (release.versionNeutral || release.versions.length === 0) return `${release.token} has none`;
  return [...new Set(release.versions.map((version) => version.token))].join(', ');
}

/** True if `text` starts with `word` followed by a space or the end. */
function startsWithWord(text: string, word: string): boolean {
  return text.startsWith(word) && (text.length === word.length || text[word.length] === ' ');
}

function explain(failures: readonly Failure[]): string {
  const furthest = Math.max(...failures.map((failure) => failure.progress));
  const messages = [...new Set(failures.filter((failure) => failure.progress === furthest).map((failure) => failure.message))];
  return messages.join('; or ');
}

function describe(parts: FileNameParts): string {
  const slots = [
    `subject "${parts.subject}"`,
    `release ${parts.release.id}`,
    parts.version === undefined ? undefined : `version "${parts.version.token}"`,
    parts.type === undefined ? 'quest form' : `type "${parts.type}"`,
    parts.number === undefined ? undefined : `number ${parts.number}`,
  ];
  return slots.filter((slot) => slot !== undefined).join(', ');
}

/** Lowercase, with jpeg/jpg treated as the same type. */
function canonicalExtension(extension: string): string {
  const lower = extension.toLowerCase();
  return lower === 'jpeg' ? 'jpg' : lower;
}
