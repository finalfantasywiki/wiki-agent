// What every group of tools uses: the context they share, input limits,
// annotations, and helpers for results.

import { z } from 'zod';
import type { LoadedRules } from '../../tasks/file-renames/load-vocabulary.ts';
import type { Profile } from '../../shared/profile/profile.ts';
import type { ReviewedFiles } from '../../shared/profile/review.ts';
import type { WikiClient } from '../../shared/wiki/client.ts';

/** What the tools work with, set up once by createServer. */
export interface ToolContext {
  readonly profile: Profile;
  readonly client: WikiClient;
  /** The wiki as tool descriptions name it: "<name> (<api>)". */
  readonly wiki: string;
  /** The naming rules, loaded once. */
  readonly rules: () => Promise<LoadedRules>;
  /** The wiki's site info, loaded once (planning needs its namespaces). */
  readonly siteInfo: () => Promise<unknown>;
  /** For thumbnails; global fetch when absent. */
  readonly fetch?: typeof fetch;
  /** Where manifests are saved. */
  readonly manifestsDir: string;
  /** Where answers to questions are saved. */
  readonly answersDir: string;
  /** The profile's files as the community reviews them. */
  readonly reviewedFiles: () => Promise<ReviewedFiles>;
}

/** Most titles one call takes, so a call stays reviewable and quick. */
export const MAX_TITLES = 50;

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
/** Writes a local manifest file; never the wiki. */
export const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export const titles = z.array(z.string().min(1)).min(1).max(MAX_TITLES);

/** Runs `load` on first call and shares its result; a failure is not kept, so the next call retries. */
export function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

export function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

export function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}
