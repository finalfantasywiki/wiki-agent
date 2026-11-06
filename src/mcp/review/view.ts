// What the review page shows of a manifest: its questions, its file and
// category renames, the files and pages it deletes or creates, and counts for
// the rest. A manifest's page
// edits can run to megabytes of diffs, so only their number is sent; the
// Markdown review file has them in full.

import type { Choice } from '../../shared/plans/answers.ts';
import { startsApproved, type Manifest, type ManifestEntry } from '../../shared/plans/manifest.ts';
import { CHOICE_LABELS } from '../../shared/plans/render-manifest.ts';

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
  readonly fileRenames: readonly ReviewFileRename[];
  readonly categoryRenames: readonly ReviewCategoryRename[];
  readonly fileDeletions: ReadonlyArray<ReviewFile>;
  readonly fileNominations: ReadonlyArray<ReviewFile>;
  readonly pageCreations: ReadonlyArray<ReviewItem & { readonly text: string }>;
  readonly pageDeletions: ReadonlyArray<ReviewItem & { readonly usedBy: readonly string[] }>;
  readonly tags: { readonly total: number; readonly approved: number };
  readonly edits: number;
  /** Why entries are blocked: usages that can't be rewritten, and leftovers. */
  readonly blocked: readonly string[];
}

export type ReviewFile = ReviewItem & { readonly pageUrl?: string; readonly thumbUrl?: string };

/** A rename. `flagged` when it has errors, a warning that isn't routine, or low confidence: it needs a look, approved or not. */
export interface ReviewRename {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly reason?: string;
  readonly approved: boolean;
  readonly flagged: boolean;
  /** Error messages; any means it can't be approved. */
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export type ReviewFileRename = ReviewRename & {
  /** The name as proposed, before numbering. */
  readonly requested: string;
  readonly confidence?: number;
  readonly pageUrl?: string;
  readonly thumbUrl?: string;
};

export type ReviewCategoryRename = ReviewRename & {
  /** How many pages and files are re-tagged. */
  readonly members: number;
  /** The new category page's text, unless the page exists already. */
  readonly newPage?: string;
  /** What happens to the old page once it's empty: nothing when there's no old page. */
  readonly oldPage: 'deleted' | 'soft redirect' | 'none';
};

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
  'file-nominate': 'Files to nominate for deletion',
  'page-create': 'Pages to create',
  'page-delete': 'Pages to delete',
  'category-tag': 'Category tags',
};

export function reviewView(manifest: Manifest): ReviewView {
  const of = <K extends ManifestEntry['kind']>(kind: K) => manifest.entries.filter((entry): entry is Entry<K> => entry.kind === kind);
  const item = (entry: Entry<'file-delete' | 'file-nominate' | 'page-create' | 'page-delete'>): ReviewItem => ({
    id: entry.id,
    title: entry.title,
    reason: entry.reason,
    approved: entry.approved,
    errors: entry.errors.map((error) => error.message),
  });
  const rename = (entry: Entry<'file-rename' | 'category-rename'>, confidence: number | undefined): ReviewRename => ({
    id: entry.id,
    from: entry.from,
    to: entry.to,
    ...(entry.kind === 'file-rename' && entry.reason !== undefined ? { reason: entry.reason } : {}),
    approved: entry.approved,
    flagged: !startsApproved(entry.errors, entry.warnings, confidence),
    errors: entry.errors.map((error) => error.message),
    warnings: entry.warnings.map((warning) => warning.message),
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
    fileRenames: of('file-rename').map((file) => ({
      ...rename(file, file.confidence),
      requested: file.requested,
      ...(file.confidence === undefined ? {} : { confidence: file.confidence }),
      ...optional({ pageUrl: file.pageUrl, thumbUrl: file.thumbUrl }),
    })),
    // A category rename has no confidence: it's what the LLM was asked to do.
    categoryRenames: of('category-rename').map((category) => ({
      ...rename(category, 1),
      members: category.members.length,
      ...(category.create === undefined ? {} : { newPage: category.create.text }),
      oldPage: category.old === undefined ? 'none' : category.old.action === 'delete' ? 'deleted' : 'soft redirect',
    })),
    fileDeletions: of('file-delete').map((file) => ({ ...item(file), ...optional({ pageUrl: file.pageUrl, thumbUrl: file.thumbUrl }) })),
    fileNominations: of('file-nominate').map((file) => ({ ...item(file), ...optional({ pageUrl: file.pageUrl, thumbUrl: file.thumbUrl }) })),
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
