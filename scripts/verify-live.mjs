import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const client = new Client({ name: 'shufersal-live-verification', version: '1' });
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
env.SHUFERSAL_ENABLE_CHECKOUT = 'false';
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], env, stderr: 'pipe' });
try {
    await client.connect(transport);
    const names = process.argv.includes('--auth-only') ? ['authenticate_shufersal']
        : ['authenticate_shufersal', 'open_shufersal', 'search_shufersal', 'get_shufersal_cart', 'get_shufersal_orders', 'get_shufersal_delivery_slots'];
    for (const name of names) {
        const response = await client.callTool({ name, arguments: name === 'search_shufersal' ? { query: 'מים מינרליים' } : {} }, undefined, { timeout: 180000 });
        if (response.isError) {
            const data = JSON.parse(response.content[0].text);
            const code = typeof data.error === 'string' ? data.error : data.error?.code;
            console.error(`${name}: ${/^[A-Z_]+$/.test(code) ? code : 'FAILED'}`);
            process.exitCode = 1;
            break;
        }
        console.log(`${name}: passed`);
    }
} catch {
    console.error('Live verification failed. Check local configuration, browser ownership and 1Password. Raw errors are suppressed.');
    process.exitCode = 1;
} finally { await client.close(); }
