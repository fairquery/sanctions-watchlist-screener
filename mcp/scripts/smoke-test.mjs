/**
 * Smoke test: initialize + tools/list + free helper without token; main tool must return APIFY_TOKEN_MISSING.
 * Optional --call runs the main tool with APIFY_TOKEN (value never printed).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverJs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const MAIN_ARGS = { names: ['Vladimir Putin'], lists: ['UN'] };

async function withClient(env, fn) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverJs], env, stderr: 'pipe' });
    const client = new Client({ name: 'fairquery-smoke', version: '1.0.0' });
    await client.connect(transport);
    try {
        return await fn(client);
    } finally {
        await client.close();
    }
}

const env = { ...process.env };
delete env.APIFY_TOKEN;
await withClient(env, async (client) => {
    const { tools } = await client.listTools();
    console.log('OK tools/list:', tools.map((t) => `${t.name}${t.outputSchema ? ' (outputSchema)' : ''}${t.annotations ? ' (annotations)' : ''}`).join(', '));
    for (const n of ['screen_names', 'list_sources']) if (!tools.some((t) => t.name === n)) throw new Error('missing tool ' + n);
    const h = await client.callTool({ name: 'list_sources', arguments: {} });
    if (h.isError || !h.structuredContent) throw new Error('helper failed: ' + JSON.stringify(h).slice(0, 300));
    console.log('OK list_sources (free, no token)');
    const r = await client.callTool({ name: 'screen_names', arguments: MAIN_ARGS });
    if (!JSON.stringify(r).includes('APIFY_TOKEN_MISSING')) throw new Error('expected APIFY_TOKEN_MISSING');
    console.log('OK screen_names without token -> APIFY_TOKEN_MISSING');
});

if (process.argv.includes('--call')) {
    if (!process.env.APIFY_TOKEN) throw new Error('APIFY_TOKEN not set for --call');
    await withClient({ ...process.env }, async (client) => {
        const r = await client.callTool({ name: 'screen_names', arguments: MAIN_ARGS });
        if (r.isError) throw new Error('call failed: ' + JSON.stringify(r).slice(0, 500));
        console.log('OK screen_names call, items:', r.structuredContent?.count);
    });
}
