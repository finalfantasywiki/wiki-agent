// Runs the MCP server over stdio for one wiki profile:
//   node src/mcp/main.ts finalfantasy
// stdout carries the protocol, so anything else goes to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadGuide, loadProfile } from '../shared/profile/profile.ts';
import { createClient } from '../shared/wiki/client.ts';
import { createServer } from './server.ts';

const name = process.argv[2];
if (name === undefined) {
  console.error('Usage: node src/mcp/main.ts <profile>   (a folder in profiles/, e.g. finalfantasy)');
  process.exit(2);
}

const profile = await loadProfile(name);
const client = createClient({ api: profile.api, contact: profile.userAgentContact, maxlag: profile.rate.maxlag });
const guide = await loadGuide(name);
await createServer({ profile, client, ...(guide === undefined ? {} : { guide }) }).connect(new StdioServerTransport());
console.error(`wiki-agent: serving ${profile.name} (${profile.api}) over stdio, read-only`);
