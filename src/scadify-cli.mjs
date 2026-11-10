#!/usr/bin/env node
// No args: stdio MCP server. `call <tool> --json '{...}'` runs one tool and prints JSON; `tools` lists them.
import { serve, makeHandlers, callTool, TOOLS } from './mcp.js';

const [cmd, name, flag, json] = process.argv.slice(2);
if (!cmd) {
  await serve();
} else if (cmd === 'tools') {
  console.log(TOOLS.map((t) => `${t.name}\t${t.description}`).join('\n'));
} else if (cmd === 'call' && name) {
  try {
    const args = flag === '--json' ? JSON.parse(json ?? '{}') : {};
    console.log(JSON.stringify(await callTool(makeHandlers(), name, args), null, 2));
  } catch (e) { console.error(String(e?.message ?? e)); process.exitCode = 1; }
} else {
  console.error('usage: scadify                      # stdio MCP server\n       scadify tools\n       scadify call <tool> --json \'{...}\'');
  process.exitCode = 2;
}
