# wiki-agent

An LLM-driven maintenance bot for MediaWiki wikis. You describe a job to Claude, such as "rename every file in this category to our naming convention and fix every page that uses them". Claude proposes the changes, and wiki-agent turns them into a **manifest**: a reviewable list of renames and per-page diffs. Nothing changes on the wiki until you approve the manifest, and every executed manifest can be undone.

wiki-agent runs as an MCP server, so it works from Claude Code or Claude Desktop. It works with any MediaWiki wiki through a per-wiki **profile**. The first profile is the [Final Fantasy Wiki](https://finalfantasy.fandom.com).

> **Status:** early development, phase 0 (read-only). It doesn't edit wikis yet.

## What it will do

1. **Mass renames:** pages, templates, files, and categories, with every reference fixed
2. **Renames by convention:** walk a category, propose names that follow the wiki's naming rules, and update every page that uses them
3. **Gallery cleanup:** replace /Gallery subpages with image categories: delete images only the galleries show, tag the rest, delete the galleries and remove every link to them
4. **Template reformatting** across pages
5. **Lua module review:** find dead or duplicated code in Scribunto modules and suggest fixes
6. **Patrol:** review new uploads and edits, and report questionable ones (e.g. to Discord)

## How it works

```
plan → manifest → approve → execute → undo
```

- **Plan.** Claude inspects the wiki through read-only tools and proposes changes.
- **Manifest.** wiki-agent checks each proposal against the profile's rules (naming grammar, allowed release names, collisions). It then finds every usage and writes the exact diffs to `manifests/<id>.json`.
- **Approve.** You review the manifest and approve entries one by one.
- **Execute.** The approved edits are made with throttling and `maxlag`. Any page edited since planning is skipped, and every action is logged.
- **Undo.** The log is replayed in reverse.

See [docs/design.md](docs/design.md) for the full design.

## Requirements

- Node.js 26 LTS (see `.node-version`)
- npm

## Setup

```bash
npm install
```

The bot's login goes in `profiles/<wiki>/credentials.json`, which git ignores. Create a bot password on the wiki's `Special:BotPasswords`, then copy `credentials.example.json` next to it and fill in the login name (`<account>@<bot password name>`) and password. The read-only phase doesn't use it yet.

## Development

```bash
npm test            # unit tests (offline, against test/fixtures)
npm run typecheck   # TypeScript 7 type check
npm run mcp -- finalfantasy   # the MCP server over stdio (read-only), for one profile
```

## Using it from Claude Code

`.mcp.json` registers the server (`wiki-agent`, for the `finalfantasy` profile) for Claude Code sessions started in this folder. Claude Code asks once before starting it. The server sends the LLM a workflow and the profile's `guide.md` as its instructions. Then ask for a plan, e.g. "plan renames for Category:Final Fantasy VII character images" or "plan deleting the galleries in Category:Character galleries from Final Fantasy VII". Manifests land in `manifests/`; open the `.md` one to review. In hosts that support MCP Apps, a review page also opens in the conversation: answer the questions, approve deletions and press **Re-plan** there.

It's started with `node` directly, not `npm run`, because npm's banner on stdout would break the protocol.

There's no build step: Node runs the TypeScript sources directly. If you use VS Code, the TypeScript 7 extension (`TypeScriptTeam.native-preview`) makes the editor match `npm run typecheck`.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Read-only: vocabulary, name validation, usage finding, manifests, MCP server, dry runs (one category's renames, one gallery's cleanup) | In progress |
| 1 | Execute and undo manifests | Planned |
| 2 | Batch renames by convention across larger categories | Planned |
| 3 | Template reformatting | Planned |
| 4 | Lua module review and refactoring | Planned |
| 5 | Upload patrol | Planned |
| 6 | Edit patrol with Discord reports | Planned |

## License

Apache-2.0. See [LICENSE](LICENSE). Dependencies keep their own licenses (`mwn` is LGPL-3.0).
