// The review page: an MCP App (the ext-apps extension) that hosts such as
// Claude draw inside the conversation. The planning tools link to it; it
// shows the manifest they saved (questions with answer buttons, files with
// thumbnails and approve boxes) and calls the tools back: answer_question,
// set_approval, replan. Text-only clients still get the tools' Markdown.
//
// The page is review-page.html (its styles) with review-page.tsx (a React
// app) bundled into it by esbuild, together with React and ext-apps, in
// memory the first time a host asks for it. So there's no build step and no
// dist/; only the page's browser ever runs the bundle.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Manifest } from '../plans/manifest.ts';
import { reviewView } from './review-view.ts';

export const REVIEW_PAGE_URI = 'ui://wiki-agent/review.html';

/** For tools that open the review page; their results carry `structuredContent: { manifestId }`. */
export const OPENS_REVIEW_PAGE = { ui: { resourceUri: REVIEW_PAGE_URI } } as const;

export interface ReviewPageOptions {
  /** Origins the page may load thumbnails from (the profile's imageHosts). */
  readonly imageHosts: readonly string[];
  readonly loadManifest: (id: string) => Promise<Manifest>;
}

export function registerReviewPage(server: McpServer, options: ReviewPageOptions): void {
  const csp = { resourceDomains: [...options.imageHosts] };
  let html: Promise<string> | undefined;
  registerAppResource(
    server,
    'Manifest review',
    REVIEW_PAGE_URI,
    { description: 'A saved manifest, to answer its questions, approve entries and plan it again', _meta: { ui: { csp } } },
    async () => {
      html ??= reviewPageHtml();
      return { contents: [{ uri: REVIEW_PAGE_URI, mimeType: RESOURCE_MIME_TYPE, text: await html, _meta: { ui: { csp, prefersBorder: true } } }] };
    },
  );

  registerAppTool(
    server,
    'review_manifest',
    {
      title: 'Manifest for review',
      description: "A saved manifest's questions, deletions, new pages and counts, for the review page.",
      inputSchema: z.object({ id: z.uuid() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      // Only the page calls it; the LLM has show_manifest.
      _meta: { ui: { resourceUri: REVIEW_PAGE_URI, visibility: ['app'] } },
    },
    async ({ id }) => {
      const view = reviewView(await options.loadManifest(id));
      return { content: [{ type: 'text', text: `Manifest ${id} for review` }], structuredContent: { ...view } };
    },
  );
}

const SCRIPT_SLOT = '<script type="module" src="review-page.tsx"></script>';

/** review-page.html with review-page.tsx bundled into its script slot. */
export async function reviewPageHtml(): Promise<string> {
  const page = await readFile(new URL('./review-page.html', import.meta.url), 'utf8');
  if (!page.includes(SCRIPT_SLOT)) throw new Error(`review-page.html has no ${SCRIPT_SLOT}`);
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('./review-page.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
    // React's and ext-apps' license notices go with their code, at the end.
    legalComments: 'eof',
    // React's production build; the development one is twice the size and warns in the console.
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  const script = outputFiles[0]!.text;
  // A "</script" inside the code would end its tag early. The replacement is
  // a function, so "$&" and the like in the code stay as they are.
  return page.replace(SCRIPT_SLOT, () => `<script type="module">${script.replaceAll('</script', '<\\/script')}</script>`);
}
