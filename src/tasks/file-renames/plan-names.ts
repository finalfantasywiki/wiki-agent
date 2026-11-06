// Turns rename proposals ("File:Aeris-ffvii-battle.png" → "File:Aeris
// Gainsborough from FFVII battle render.png") into planned names: each new
// name is validated against the naming rules, and numbered so it collides
// with nothing on the wiki or elsewhere in the batch. Names that differ only by
// extension count as colliding. The LLM proposes names without worrying about
// numbers; this assigns them.

import type { WikiClient } from '../../shared/wiki/client.ts';
import { getFileInfo, pagesExist } from '../../shared/wiki/read.ts';
import { formatFileName, normalizeFileName, validateFileName, type FileNameParts, type Issue, type NamingRules } from './file-name.ts';

export interface RenameProposal {
  /** The current file, e.g. "File:Aeris-ffvii-battle.png" (the prefix is optional). */
  readonly from: string;
  /** The proposed name; a number may be added or changed to avoid collisions. */
  readonly to: string;
  /** Why this name, for the reviewer. */
  readonly reason?: string;
  /** How sure the proposer is, from 0 to 1. */
  readonly confidence?: number;
}

export type PlanIssueCode = Issue['code'] | 'source-missing' | 'duplicate-source' | 'renumbered' | 'extension-twin' | 'unnumbered-sibling' | 'no-free-number' | 'unchanged';

export interface PlanIssue {
  readonly code: PlanIssueCode;
  readonly message: string;
}

export interface PlannedName {
  readonly from: string;
  /** The name as proposed. */
  readonly requested: string;
  /** The name to use: `requested`, renumbered if it collided. */
  readonly to: string;
  readonly parts: FileNameParts | undefined;
  readonly reason: string | undefined;
  readonly confidence: number | undefined;
  /** Any error blocks the rename. */
  readonly errors: readonly PlanIssue[];
  readonly warnings: readonly PlanIssue[];
  /** The source file's page on the wiki, and a thumbnail of it, for review. */
  readonly pageUrl: string | undefined;
  readonly thumbUrl: string | undefined;
}

/** Width of the thumbnail kept for review, as in the gallery cleanup. */
const THUMB_WIDTH = 160;
/** How many numbered candidates to check per name in one request. */
const NUMBERS_PER_ROUND = 5;
/** Give up numbering past this, which would mean something is badly wrong. */
const MAX_NUMBER = 50;
/**
 * Extensions checked for twins of each candidate ("X.png" vs "X.jpg"), with the
 * file's own. 5 candidates times these still fit in one 50-title request.
 */
const TWIN_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

export async function planNames(client: WikiClient, rules: NamingRules, proposals: readonly RenameProposal[]): Promise<PlannedName[]> {
  const sources = proposals.map((proposal) => withFilePrefix(proposal.from));
  const infos = await getFileInfo(client, sources, THUMB_WIDTH);
  const seenSources = new Set<string>();

  // Validate first; numbering only applies to names that parse.
  const drafts = proposals.map((proposal, index) => {
    const from = infos[index]?.title ?? sources[index]!;
    const errors: PlanIssue[] = [];
    const warnings: PlanIssue[] = [];
    if (infos[index]?.exists !== true) {
      errors.push({ code: 'source-missing', message: `${from} does not exist` });
    }
    if (seenSources.has(from)) {
      errors.push({ code: 'duplicate-source', message: `${from} is proposed more than once` });
    }
    seenSources.add(from);

    const requested = withFilePrefix(proposal.to);
    const validation = validateFileName(requested, rules, { originalExtension: extensionOf(from) });
    errors.push(...validation.errors);
    warnings.push(...validation.warnings);
    return { proposal, from, requested, parts: validation.parts, errors, warnings };
  });

  const assigned = await assignNumbers(client, drafts);
  return drafts.map((draft, index) => {
    const to = assigned[index]?.name ?? draft.requested;
    const warnings = [...draft.warnings];
    if (to !== draft.requested) {
      const why = assigned[index]?.sharedInBatch === true ? 'other files in this batch have the same name, so they are numbered as a set' : `${draft.requested} is taken`;
      warnings.push({ code: 'renumbered', message: `${why}; it becomes ${to}` });
    }
    for (const twin of assigned[index]?.twins ?? []) {
      warnings.push({
        code: 'extension-twin',
        message: `${twin} has the same name apart from its extension: check whether it's a duplicate, or what tells them apart`,
      });
    }
    for (const sibling of assigned[index]?.unnumberedSiblings ?? []) {
      warnings.push({
        code: 'unnumbered-sibling',
        message: `${sibling} has no number: add it to this batch, so the whole set is numbered from 1`,
      });
    }
    if (titleKey(to) === titleKey(draft.from)) {
      warnings.push({ code: 'unchanged', message: 'the file already has this name' });
    }
    return {
      from: draft.from,
      requested: draft.requested,
      to,
      parts: draft.parts,
      reason: draft.proposal.reason,
      confidence: draft.proposal.confidence,
      errors: draft.errors,
      warnings,
      pageUrl: infos[index]?.pageUrl,
      thumbUrl: infos[index]?.thumbUrl,
    };
  });
}

interface Draft {
  readonly from: string;
  readonly requested: string;
  readonly parts: FileNameParts | undefined;
  readonly errors: PlanIssue[];
}

interface Assigned {
  readonly name: string;
  /** Files skipped over because their names differ from a candidate only by extension. */
  readonly twins: readonly string[];
  /** Existing files with the same name and no number, which should join the numbered set. */
  readonly unnumberedSiblings: readonly string[];
  /** Whether other drafts in the batch want the same name. */
  readonly sharedInBatch: boolean;
}

/**
 * Numbers each valid draft. A file that is alone keeps no number; files that
 * are alike are numbered as a set from 1 (none, then 1, 2, 3, ...). So a draft
 * goes unnumbered only if no other draft has its name, and neither its name nor
 * its name with "1" is taken. Otherwise it gets the first free number from its
 * requested one upward.
 *
 * A name is taken if a page exists there with any extension (unless it's the
 * file itself) or an earlier draft in the batch got it. Files being renamed
 * away still count as taken: their names are only free after the move.
 */
async function assignNumbers(client: WikiClient, drafts: readonly Draft[]): Promise<Array<Assigned | undefined>> {
  const exists = new Map<string, boolean>();
  /** The name each earlier draft got, by its key without extension. */
  const claimed = new Map<string, string>();
  const result: Array<Assigned | undefined> = [];

  const valid = (draft: Draft): draft is Draft & { parts: FileNameParts } => draft.parts !== undefined && draft.errors.length === 0;
  const draftsPerName = new Map<string, number>();
  for (const draft of drafts.filter(valid)) {
    const key = stemKey(nameFor(draft.parts, undefined));
    draftsPerName.set(key, (draftsPerName.get(key) ?? 0) + 1);
  }

  for (const draft of drafts) {
    if (!valid(draft)) {
      result.push(undefined);
      continue;
    }
    const parts = draft.parts;
    const unnumbered = nameFor(parts, undefined);
    const shared = (draftsPerName.get(stemKey(unnumbered)) ?? 0) > 1;
    const ownKey = titleKey(draft.from);
    const extensions = [...new Set([parts.extension, ...TWIN_EXTENSIONS])];
    const variants = (name: string) => extensions.map((extension) => withExtension(name, extension));
    /** Files that hold `name` in some extension, other than the file itself. */
    const holders = (name: string) =>
      [...variants(name).filter((title) => exists.get(titleKey(title)) === true), ...[claimed.get(stemKey(name))].filter((title) => title !== undefined)].filter(
        (title) => titleKey(title) !== ownKey,
      );

    const twins = new Set<string>();
    let chosen: string | undefined;
    let number = parts.number;
    let firstRound = true;
    while (chosen === undefined && (number ?? 1) <= MAX_NUMBER) {
      // Check this candidate and the next few, with every extension, in one
      // request. The first round also checks the unnumbered name.
      const round: Array<number | undefined> = [];
      for (let n = number, i = 0; i < NUMBERS_PER_ROUND && (n ?? 1) <= MAX_NUMBER; i++, n = (n ?? 0) + 1) {
        round.push(n);
      }
      const names = round.map((n) => nameFor(parts, n));
      await checkExistence(client, [...(firstRound ? [unnumbered] : []), ...names].flatMap(variants), exists);
      firstRound = false;
      for (const [i, n] of round.entries()) {
        const candidate = names[i]!;
        const takenBy = holders(candidate);
        // Unnumbered only when alone: "X 1" taken means a set already exists.
        const free = takenBy.length === 0 && (n !== undefined || (!shared && holders(nameFor(parts, 1)).length === 0));
        if (free) {
          chosen = candidate;
          break;
        }
        for (const title of takenBy) {
          if (extensionOf(title).toLowerCase() !== extensionOf(candidate).toLowerCase()) twins.add(title);
        }
        number = (n ?? 0) + 1;
      }
    }
    if (chosen === undefined) {
      draft.errors.push({ code: 'no-free-number', message: `no free number up to ${MAX_NUMBER} for ${draft.requested}` });
      result.push(undefined);
    } else {
      claimed.set(stemKey(chosen), chosen);
      const unnumberedSiblings = chosen === unnumbered ? [] : variants(unnumbered).filter((title) => exists.get(titleKey(title)) === true && titleKey(title) !== ownKey);
      result.push({ name: chosen, twins: [...twins], unnumberedSiblings, sharedInBatch: shared });
    }
  }
  return result;
}

/** The full title for these parts with `number`, capitalized as MediaWiki will store it. */
function nameFor(parts: FileNameParts, number: number | undefined): string {
  return `File:${capitalize(
    formatFileName({
      subject: parts.subject,
      release: parts.form === 'titled' ? undefined : parts.release.token,
      version: parts.version?.token,
      type: parts.type,
      number,
      extension: parts.extension,
    }),
  )}`;
}

async function checkExistence(client: WikiClient, titles: readonly string[], cache: Map<string, boolean>): Promise<void> {
  const unknown = titles.filter((title) => !cache.has(titleKey(title)));
  if (unknown.length === 0) return;
  for (const existence of await pagesExist(client, unknown)) {
    cache.set(titleKey(existence.title), existence.exists);
  }
}

/** Compares titles the way MediaWiki does for files: first letter and spaces/underscores. */
function titleKey(title: string): string {
  return capitalize(normalizeFileName(title));
}

/** `titleKey` without the extension, so "X.png" and "X.jpg" compare equal. */
function stemKey(title: string): string {
  const key = titleKey(title);
  return key.slice(0, key.lastIndexOf('.'));
}

function withExtension(title: string, extension: string): string {
  return `${title.slice(0, title.lastIndexOf('.'))}.${extension}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function withFilePrefix(title: string): string {
  return /^(File|Image):/i.test(title) ? `File:${normalizeFileName(title)}` : `File:${title.replaceAll('_', ' ')}`;
}

function extensionOf(title: string): string {
  return title.slice(title.lastIndexOf('.') + 1);
}
