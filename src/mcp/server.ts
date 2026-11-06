// The MCP server: wraps the library as tools for an LLM. Tools are thin: they
// check their input with zod, call the library, and return JSON. Everything
// here is read-only (phase 0); write tools come in phase 1 and will only
// take approved manifest IDs.
//
// The tools are in tools/, by group:
// - wiki.ts: category members, pages, file info, usages
// - naming.ts: the vocabulary, validating names
// - planning.ts: plan a batch (renames or gallery cleanup) into a manifest,
//   answer its questions, plan it again, show it, approve entries. These
//   write manifests and answers to local folders, never to the wiki.
// - profile-review.ts: whether the community has reviewed the profile
// The review page (review/app.ts) opens from the planning tools in hosts
// that draw MCP Apps.

import { McpServer } from '@modelcontextprotocol/server';
import { loadNamingRules, type LoadedRules } from '../tasks/file-renames/load-vocabulary.ts';
import { ANSWERS_DIR } from '../shared/plans/answers.ts';
import { loadManifest, MANIFESTS_DIR } from '../shared/plans/manifest.ts';
import type { Profile } from '../shared/profile/profile.ts';
import { loadReviewedFiles, type ReviewedFiles } from '../shared/profile/review.ts';
import type { WikiClient } from '../shared/wiki/client.ts';
import { registerReviewPage } from './review/app.ts';
import { once, type ToolContext } from './tools/common.ts';
import { registerNamingTools } from './tools/naming.ts';
import { registerPlanningTools } from './tools/planning.ts';
import { registerProfileReviewTool } from './tools/profile-review.ts';
import { registerWikiTools } from './tools/wiki.ts';
import { WORKFLOW } from './workflow.ts';

export interface ServerContext {
  readonly profile: Profile;
  readonly client: WikiClient;
  /** For thumbnails; replaceable in tests. Defaults to global fetch. */
  readonly fetch?: typeof fetch;
  /** The naming rules; replaceable in tests. Defaults to loading them from the wiki, once. */
  readonly rules?: () => Promise<LoadedRules>;
  /** Where manifests are saved. Defaults to manifests/ in the repo. */
  readonly manifestsDir?: string;
  /** Where answers to questions are saved. Defaults to answers/ in the repo. */
  readonly answersDir?: string;
  /** The profile's guide (profiles/<name>/guide.md), added to the server's instructions. */
  readonly guide?: string;
  /** The profile's files as the community reviews them; replaceable in tests. Defaults to reading them from disk. */
  readonly reviewedFiles?: () => Promise<ReviewedFiles>;
}

export function createServer(context: ServerContext): McpServer {
  const { profile, client } = context;
  const instructions = context.guide === undefined ? WORKFLOW : `${WORKFLOW}\n\n${context.guide}`;
  const server = new McpServer({ name: 'wiki-agent', version: '0.1.0' }, { instructions });
  const tools: ToolContext = {
    profile,
    client,
    wiki: `${profile.name} (${profile.api})`,
    rules: once(context.rules ?? (() => loadNamingRules(client, profile))),
    siteInfo: once(() => client.getSiteInfo()),
    ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
    manifestsDir: context.manifestsDir ?? MANIFESTS_DIR,
    answersDir: context.answersDir ?? ANSWERS_DIR,
    reviewedFiles: context.reviewedFiles ?? (() => loadReviewedFiles(profile.name)),
  };

  registerReviewPage(server, { imageHosts: profile.imageHosts ?? [], loadManifest: (id) => loadManifest(id, tools.manifestsDir) });
  registerWikiTools(server, tools);
  registerNamingTools(server, tools);
  registerPlanningTools(server, tools);
  registerProfileReviewTool(server, tools);
  return server;
}
