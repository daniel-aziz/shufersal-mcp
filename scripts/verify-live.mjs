import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (!process.env.SHUFERSAL_SITE_PROFILE) {
    console.error('Set SHUFERSAL_SITE_PROFILE to a locally reviewed profile. No live check was started.');
    process.exitCode = 1;
} else {
    const client = new Client({ name: 'shufersal-read-only-verification', version: '1' });
    const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
    env.SHUFERSAL_ENABLE_CHECKOUT = 'false';
    const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], env, stderr: 'pipe' });
    try {
        await client.connect(transport);
        for (const name of ['open_shufersal', 'get_shufersal_cart', 'get_shufersal_orders', 'get_shufersal_delivery_slots']) {
            const response = await client.callTool({ name, arguments: {} });
            if (response.isError) throw new Error(`Read-only verification failed at ${name}. Inspect the authenticated site/profile locally.`);
            console.log(`${name}: passed`);
        }
        console.log('Read-only verification passed. No cart mutations or checkout tools were called.');
    } catch {
        console.error('Live verification failed. Check browser access, authentication, site profile and ownership. Raw results are suppressed.');
        process.exitCode = 1;
    } finally { await client.close(); }
}
