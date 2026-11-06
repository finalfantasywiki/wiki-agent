# AGENTS.md

Instructions for AI coding agents working in this repo. The full design is in [docs/design.md](docs/design.md). Read it before changing behavior.

## What this is

wiki-agent is an LLM-driven maintenance bot for MediaWiki wikis, exposed as an MCP server. The LLM proposes *what* to do (names, targets). Deterministic code does *how* (finding usages, diffs, throttled edits, undo). All wiki-specific settings live in a **profile** (`profiles/<wiki>/`). The first profile is the Final Fantasy Wiki (`finalfantasy.fandom.com`).

Current phase: **0 (read-only)**. See "Phase 0 scope" and "Build steps" in the design doc.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Runs `node --test` over `test/**/*.test.ts`, offline against fixtures |
| `npm run typecheck` | `tsc --noEmit` (TypeScript 7). This is the authoritative type check. |
| `npm run mcp -- <profile>` | The MCP server over stdio (`src/mcp/main.ts`). Talks to the live wiki, read-only. |

Run both after every change.

## Stack and code rules

- **Node 26 LTS** runs `.ts` files directly through type stripping. There's no build step and no `dist/`.
- **TypeScript 7**, `target: es2025`, `strict`, `noUncheckedIndexedAccess`. `tsc` only type-checks.
- Type stripping means:
  - no `enum`, `namespace`, or constructor parameter properties (`erasableSyntaxOnly` enforces this)
  - relative imports include the `.ts` extension: `import { x } from './foo.ts'`
  - type-only imports use `import type`
- ES modules only (`"type": "module"`).
- Prefer Node built-ins: `fetch`, `node:test`, `node:assert/strict`.

## Dependencies

**Check for an existing library before writing a utility yourself** (API clients, parsers, continuation and batching, diffing...), and propose it.

**Never add a dependency without the user's approval.** First tell them its name, version, purpose, and alternatives, then wait for a yes.

| Package | Version | Kind | Purpose |
|---|---|---|---|
| `luaparse` | 0.3.1 | runtime | Parse Lua (Scribunto modules) |
| `mwn` | 3.0.3 | runtime | MediaWiki API client (LGPL-3.0): requests, continuation, maxlag/retries; login and edits in phase 1. Wrapped by `src/shared/wiki/`; nothing else imports it. |
| `diff` | 9.0.0 | runtime | Unified diffs of planned page edits |
| `zod` | 4.6.7 | runtime | Schemas: manifests now, MCP tool inputs and outputs in step 5 |
| `@modelcontextprotocol/server` | 2.4.0 | runtime | MCP server (official SDK v2, Apache-2.0): `McpServer`, `registerTool` with zod schemas, stdio. Brings only `@modelcontextprotocol/core` (which needs only zod). Chosen over the v1 `@modelcontextprotocol/sdk`, which bundles Express, Hono, OAuth and a client we don't need. |
| `@modelcontextprotocol/ext-apps` | 2.0.4 | runtime | MCP Apps (MIT): the in-chat review page. `./server` registers the page and its tools; `./app-with-deps` is a self-contained browser script, inlined into the page so there's no bundler. Requires `@modelcontextprotocol/client` 2.x as a peer (installed with it; nothing imports it directly). Its `./react` hooks (`useApp`, `useHostStyles`, …) are used by the review page. |
| `react`, `react-dom` | 19.3.1 | runtime | The review page (`src/mcp/review/page.tsx`), bundled by esbuild; they run only in the host's browser, never in the server. |
| `esbuild` | 0.28.2 | runtime | Bundles the review page with React and ext-apps into one script, in memory, the first time the server serves it. No `dist/`. Its binary comes from `@esbuild/<platform>`, so its postinstall script isn't needed. |
| `typescript` | 7.0.2 | dev | Type-checking only |
| `@types/node` | 26.6.6 | dev | Node types (mwn pulls a nested `@types/node` 14; `skipLibCheck` keeps it harmless) |
| `@types/luaparse` | 0.2.13 | dev | luaparse types (written for 0.2; augment locally if needed) |
| `@types/react`, `@types/react-dom` | 19.3.0 | dev | React types, for type-checking the review page |

Candidates that are **not approved yet**: `wikiparser-node` (wikitext parser).

Notes on `mwn`: its `read()` / `massQuery()` batch titles but don't follow continuation within a batch, and `File#usages()` / `Page#backlinks()` drop namespaces or don't continue; `src/shared/wiki/read.ts` covers those on top of `continuedQueryGen`. In tests, use `test/helpers/fake-wiki.ts` (a real `Mwn` with `request` stubbed).

## Wiki safety

- **Phase 0 never writes to any wiki.** No login, and no API call that edits, moves, uploads, or deletes.
- A profile's `rules` (edit summary naming the operator, public review of profile changes, where pages may be created, forbidden templates) are the community's conditions for running the bot. Don't weaken them, and don't plan around them.
- Every request sends a descriptive User-Agent with a contact. Fandom returns 403 to default ones.
- Lua runs **only on the wiki** (the export module or the Scribunto console). The tool parses Lua with `luaparse` and never executes it.
- Tests run offline against `test/fixtures/`. Don't call live wikis from tests.
- Fixtures are hand-written samples in the shape of wiki data. Don't commit content copied from a wiki (Fandom text is CC BY-SA), and don't commit one-off maintenance scripts for a specific wiki.
- Code for one task (e.g. file renames) goes in its own folder under `src/tasks/`; code several tasks use goes in `src/shared/`.

## Layout

```
docs/design.md        design and decisions (the source of truth)
profiles/<wiki>/      per-wiki configuration: profile.json, and guide.md (the wiki's naming guide, sent to the LLM);
                      credentials.json holds the bot's BotPassword login and is gitignored (never commit it, never
                      print it); credentials.example.json shows its shape
.mcp.json             registers the MCP server for Claude Code (node directly: npm's banner would break stdio)
src/                  library code
  shared/             code several tasks use
    profile/          wiki profiles (profile.ts), and their public review (review.ts): the text to post on the
                      wiki, and the check that it's current
    wiki/             MediaWiki API client
    lua/              Lua (Scribunto) parsing
    sources/          wiki data adapters, e.g. Module:Codename
    wikitext/         wikitext editing: rewriting references on rename, removing links to deleted pages
    plans/            planning wiki changes for review: page edits with diffs, manifests
  tasks/              one folder per maintenance task
    plan-batch.ts     plans one batch across tasks (file and category renames) into a manifest
    file-renames/     the file-renaming task: vocabulary, file-name grammar, ...
    category-renames/ the category-renaming task: new pages from a model, members, old pages
    gallery-cleanup/  the gallery-cleanup task: reading /Gallery pages, sorting their images, planning a batch
  mcp/                the MCP server: createServer (server.ts), stdio entry point (main.ts), the instructions
                      sent to the LLM (workflow.ts)
    tools/            thin tools over the library, by group: wiki.ts, naming.ts, planning.ts,
                      profile-review.ts; common.ts holds their shared context and helpers
    review/           the in-chat review page: app.ts registers and bundles it, page.tsx is the React app,
                      page.html its styles, view.ts what it shows of a manifest
test/                 mirrors src/; fixtures/ holds small hand-written samples
```

## Where vocabulary comes from

For the FF Wiki, file-name tokens live in the wiki's own data, not in this repo:
- `files.shorthand` on a release or version in `Module:Codename/data`, falling back to `id` (releases) or `name` (versions)
- `files.versionneutral = true` on releases whose images don't differ between versions

The profile's `vocabulary` section is only an override layer. Don't add FF tokens there that belong in the data; propose them for the wiki instead (see [docs/codename-files.md](docs/codename-files.md)).

## Known gotchas

- The MCP server's stdout is the protocol. Log to stderr (`console.error`), never `console.log`, anywhere the server runs.
- Tests talk to the server through `test/helpers/mcp-client.ts` (JSON-RPC over `InMemoryTransport`). The client package is only installed as ext-apps' peer, so tests don't use it.

- mwn's `Wikitext` `Unbinder` loses nested regions (`<pre><nowiki>…</nowiki></pre>` comes back as `%UNIQ…%` placeholders). `src/shared/wikitext/references.ts` masks those regions itself; don't use `unbind()`.
- `imageusage` lists pages that show a file through a transcluded template, so a page can "use" a file its own wikitext never mentions. The reference to rewrite is in the template.
- Fandom's image CDN serves a 404 placeholder to images requested with another site's Referer. The review page sets `<meta name="referrer" content="no-referrer">`; keep it.
- `review/page.tsx` runs only in the host's browser: Node never imports it (type stripping doesn't do JSX), and tests can't run it. `tsc` checks it; check what it looks like in a browser. Put logic the page needs (e.g. which renames are flagged) in `review/view.ts`, where tests reach it.
- MediaWiki never stores trailing whitespace, so planned page text shouldn't end in a newline either; it only adds noise to diffs.

- **luaparse and non-ASCII strings.** The default `encodingMode: 'none'` leaves `StringLiteral.value` as `null`. The other modes reject characters above U+00FF. The fix:
  1. Parse `Buffer.from(src, 'utf8').toString('latin1')` with `encodingMode: 'pseudo-latin1'`.
  2. Decode each string back with `Buffer.from(value, 'latin1').toString('utf8')`.

  Side effect: AST `range` offsets are then **byte** offsets, not JS string indices. Convert them before doing any range-based edit.
- `mw.text.jsonEncode` encodes an empty Lua table as `[]`. Normalize before comparing export data with parsed data.

## Working with the user

- Write code **one step at a time**: one file, or a module plus its test. Name every file you wrote or changed, run the tests and type-check, then stop for review.
- **Never commit, push, or open a PR** unless the user says so. When work looks ready, suggest a commit message.
- Use American English spelling.
- Keep `README.md`, this file, and `docs/design.md` up to date as the code changes.
