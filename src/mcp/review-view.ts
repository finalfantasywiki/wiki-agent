// What the review page shows of a manifest: its questions, the files and
// pages it deletes or creates, and counts for the rest. A manifest's page
// edits can run to megabytes of diffs, so only their number is sent; the
// Markdown review file has them in full.

import type { Choice } from '../plans/answers.ts';
import type { Manifest, ManifestEntry } from '../plans/manifest.ts';
import { CHOICE_LABELS } from '../plans/render-manifest.ts';

type Entry<K extends ManifestEntry['kind']> = Extract<ManifestEntry, { kind: K }>;

export interface ReviewView {
  readonly id: string;
  readonly wiki: string;
  readonly created: string;
  /** Whether replan can plan it again. */
  readonly replannable: boolean;
  readonly summary: ReadonlyArray<{ readonly label: string; readonly total: number; readonly approved: number; readonly withErrors: number }>;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly about: string;
    readonly question: string;
    readonly choices: ReadonlyArray<{ readonly choice: Choice; readonly label: string }>;
    readonly answer?: string;
    readonly pageUrl?: string;
    readonly thumbUrl?: string;
  }>;
  readonly fileDeletions: ReadonlyArray<ReviewItem & { readonly pageUrl?: string; readonly thumbUrl?: string }>;
  readonly pageCreations: ReadonlyArray<ReviewItem & { readonly text: string }>;
  readonly pageDeletions: ReadonlyArray<ReviewItem & { readonly usedBy: readonly string[] }>;
  readonly tags: { readonly total: number; readonly approved: number };
  readonly edits: number;
  /** Why entries are blocked: usages that can't be rewritten, and leftovers. */
  readonly blocked: readonly string[];
}

export interface ReviewItem {
  readonly id: string;
  readonly title: string;
  readonly reason: string;
  readonly approved: boolean;
  /** Error messages; any means it can't be approved. */
  readonly errors: readonly string[];
}

const LABELS: Record<ManifestEntry['kind'], string> = {
  question: 'Questions',
  'category-rename': 'Category renames',
  'file-rename': 'File renames',
  'file-delete': 'File deletions',
  'page-create': 'Pages to create',
  'page-delete': 'Pages to delete',
  'category-tag': 'Category tags',
};

export function reviewView(manifest: Manifest): ReviewView {
  const of = <K extends ManifestEntry['kind']>(kind: K) => manifest.entries.filter((entry): entry is Entry<K> => entry.kind === kind);
  const item = (entry: Entry<'file-delete' | 'page-create' | 'page-delete'>): ReviewItem => ({
    id: entry.id,
    title: entry.title,
    reason: entry.reason,
    approved: entry.approved,
    errors: entry.errors.map((error) => error.message),
  });
  const tags = of('category-tag');
  return {
    id: manifest.id,
    wiki: manifest.wiki,
    created: manifest.created,
    replannable: manifest.request !== undefined,
    summary: (Object.keys(LABELS) as Array<ManifestEntry['kind']>).flatMap((kind) => {
      const entries = manifest.entries.filter((entry) => entry.kind === kind);
      if (entries.length === 0) return [];
      const decided = entries.filter((entry) => entry.kind !== 'question');
      return [{ label: LABELS[kind], total: entries.length, approved: decided.filter((entry) => entry.approved).length, withErrors: decided.filter((entry) => entry.errors.length > 0).length }];
    }),
    questions: of('question').map((question) => ({
      id: question.id,
      about: question.about,
      question: question.question,
      choices: (question.choices ?? []).map((choice) => ({ choice, label: CHOICE_LABELS[choice] })),
      ...optional({ answer: question.answer, pageUrl: question.pageUrl, thumbUrl: question.thumbUrl }),
    })),
    fileDeletions: of('file-delete').map((file) => ({ ...item(file), ...optional({ pageUrl: file.pageUrl, thumbUrl: file.thumbUrl }) })),
    pageCreations: of('page-create').map((page) => ({ ...item(page), text: page.text })),
    pageDeletions: of('page-delete').map((page) => ({ ...item(page), usedBy: page.usedBy })),
    tags: { total: tags.length, approved: tags.filter((tag) => tag.approved).length },
    edits: manifest.edits.length,
    blocked: [
      ...manifest.usages.filter((usage) => usage.status === 'unresolved').map((usage) => `${usage.page} (${usage.kind}) uses ${usage.from}, and its text can't be rewritten`),
      ...manifest.leftovers.map((leftover) => `${leftover.page} still mentions ${leftover.from}: ${leftover.line}`),
    ],
  };
}

/** The fields that are set. */
function optional<T extends Record<string, string | undefined>>(fields: T): { [K in keyof T]?: string } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as { [K in keyof T]?: string };
}
