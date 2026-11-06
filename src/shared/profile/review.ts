// The public review of a profile (rules.profileReview): the profile's files
// are posted on a wiki page so the community can read every change before
// the bot runs on it. This makes the text to post, and checks the page:
// it must show the current files, unchanged for the profile's number of days.
//
// Only the marked blocks count. The rest of the page (e.g. the bot's user
// page: what it does, who runs it) can change without restarting the clock.
//
// Phase 0 posts nothing; the operator pastes the text. In phase 1 the
// executor refuses to run until the check says "ready".

import { readFile } from 'node:fs/promises';
import type { Profile } from './profile.ts';
import type { WikiClient } from '../wiki/client.ts';
import { revisionHistory } from '../wiki/read.ts';

/** The files the community reviews, as they are on disk. */
export interface ReviewedFiles {
  readonly 'profile.json': string;
  /** Undefined if the profile has no guide. */
  readonly 'guide.md'?: string | undefined;
}

export type ReviewedFile = keyof ReviewedFiles;

const FILES: ReadonlyArray<{ readonly name: ReviewedFile; readonly lang: string }> = [
  { name: 'profile.json', lang: 'json' },
  { name: 'guide.md', lang: 'markdown' },
];

const BLOCK = /<!-- wiki-agent: (profile\.json|guide\.md) -->\s*<syntaxhighlight\b[^>]*>\n?([\s\S]*?)<\/syntaxhighlight>/g;

export type ReviewStatus =
  /** The page doesn't exist. */
  | { readonly state: 'missing'; readonly page: string }
  /** The page doesn't show the current files; these differ. */
  | { readonly state: 'outdated'; readonly page: string; readonly differs: readonly ReviewedFile[] }
  /** It does, but not for long enough yet. */
  | { readonly state: 'waiting'; readonly page: string; readonly since: string; readonly readyAt: string }
  /** `since`: unchanged since at least then (the history is read only as far back as needed). */
  | { readonly state: 'ready'; readonly page: string; readonly since: string };

/** Reads profiles/<name>/profile.json and guide.md as they are. */
export async function loadReviewedFiles(name: string): Promise<ReviewedFiles> {
  const dir = new URL(`../../../profiles/${name}/`, import.meta.url);
  const profile = await readFile(new URL('profile.json', dir), 'utf8');
  try {
    return { 'profile.json': profile, 'guide.md': await readFile(new URL('guide.md', dir), 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { 'profile.json': profile };
    throw error;
  }
}

/** The text to post on the review page: each file in a marked block. */
export function reviewText(files: ReviewedFiles): string {
  const blocks = FILES.flatMap(({ name, lang }) => {
    const text = files[name];
    if (text === undefined) return [];
    if (text.includes('</syntaxhighlight>')) throw new Error(`${name} contains </syntaxhighlight>, so it can't be posted in a block`);
    return [`'''${name}'''\n<!-- wiki-agent: ${name} -->\n<syntaxhighlight lang="${lang}">\n${normalize(text)}\n</syntaxhighlight>`];
  });
  return [
    '<!-- The files below are copied from the bot\'s profile. Change the profile, not this text: the bot only runs once this matches it. -->',
    ...blocks,
  ].join('\n');
}

/** The files a page shows, from its marked blocks. */
export function readReviewText(page: string): Partial<Record<ReviewedFile, string>> {
  const found: Partial<Record<ReviewedFile, string>> = {};
  for (const match of page.matchAll(BLOCK)) {
    found[match[1] as ReviewedFile] = normalize(match[2] ?? '');
  }
  return found;
}

/** The files a page's blocks don't match. */
export function differences(page: string, files: ReviewedFiles): ReviewedFile[] {
  const shown = readReviewText(page);
  return FILES.map(({ name }) => name).filter((name) => shown[name] !== (files[name] === undefined ? undefined : normalize(files[name]!)));
}

/**
 * Whether the profile's review page shows `files`, and since when. Reads the
 * page's history back only as far as it needs to. Undefined if the profile
 * has no review rule.
 */
export async function checkProfileReview(client: WikiClient, profile: Profile, files: ReviewedFiles, now = new Date()): Promise<ReviewStatus | undefined> {
  const rule = profile.rules?.profileReview;
  if (rule === undefined) return undefined;
  const page = rule.page;
  const period = rule.days * 24 * 60 * 60 * 1000;

  let since: string | undefined;
  for await (const revision of revisionHistory(client, page)) {
    const differs = differences(revision.content, files);
    if (since === undefined && differs.length > 0) return { state: 'outdated', page, differs };
    // An older revision that differs: the current files were posted after it.
    if (differs.length > 0) break;
    since = revision.timestamp;
    if (now.getTime() - Date.parse(since) >= period) break;
  }
  if (since === undefined) return { state: 'missing', page };

  const readyAt = new Date(Date.parse(since) + period);
  return readyAt <= now ? { state: 'ready', page, since } : { state: 'waiting', page, since, readyAt: readyAt.toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

/** MediaWiki keeps neither \r nor trailing whitespace. */
function normalize(text: string): string {
  return text.replaceAll('\r\n', '\n').trimEnd();
}
