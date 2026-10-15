import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ShoppingService } from '../dist/shopping/service.js';
import { registerShoppingTools } from '../dist/tools/shopping.js';
import { FakeSite, MemoryJournal } from './helpers.mjs';

export async function connect(site, journal = new MemoryJournal(), enabled = true) {
    const server = new McpServer({ name: 'test-server', version: '1' });
    registerShoppingTools(server, new ShoppingService(site, journal, enabled));
    const client = new Client({ name: 'test-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    return { client, server, async close() { await client.close(); await server.close(); } };
}
const result = response => JSON.parse(response.content[0].text);

test('MCP exposes annotations and enforces guard inputs before mutation', async () => {
    const site = new FakeSite(); const connection = await connect(site);
    try {
        const { tools } = await connection.client.listTools();
        assert.equal(tools.find(tool => tool.name === 'get_shufersal_cart').annotations.readOnlyHint, true);
        assert.equal(tools.find(tool => tool.name === 'submit_shufersal_order').annotations.destructiveHint, true);
        const invalid = await connection.client.callTool({ name: 'add_to_shufersal_cart', arguments: { productId: 'milk', sellingMethod: 'unit', quantity: 1 } });
        assert.equal(invalid.isError, true); assert.equal(site.writes, 0);
        const cart = result(await connection.client.callTool({ name: 'get_shufersal_cart', arguments: {} })).result;
        const added = result(await connection.client.callTool({ name: 'add_to_shufersal_cart', arguments: { productId: 'milk', sellingMethod: 'unit', quantity: 1, expectedRevision: cart.revision, operationId: randomUUID() } }));
        assert.equal(added.ok, true); assert.equal(added.result.quantity, 3);
    } finally { await connection.close(); }
});
test('MCP errors never expose raw browser secrets', async () => {
    const site = new FakeSite(); site.search = async () => { throw Error('password=secret cookie=secret'); };
    const connection = await connect(site);
    try {
        const response = await connection.client.callTool({ name: 'search_shufersal', arguments: { query: 'milk' } });
        assert.equal(response.isError, true); assert.doesNotMatch(JSON.stringify(response), /password|cookie|secret/);
    } finally { await connection.close(); }
});
