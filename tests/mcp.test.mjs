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


test('replenishment plans from stock and history, preserves team items and stops replenishing at target', async () => {
    const site = new FakeSite();
    site.history = [4, 6, 100].map((quantity, i) => {
        const cart = structuredClone(site.current); cart.items[0].quantity = quantity;
        if (i === 2) cart.items.push({ ...cart.items[0], productId: 'one-off', quantity: 1 });
        return { orderNumber: `history-${i}`, status: 'delivered', cart };
    });
    site.current.items.push({ ...site.current.items[0], productId: 'team-item', quantity: 9 }); site.reprice();
    const connection = await connect(site);
    const input = { orderNumbers: site.history.map(o => o.orderNumber), stock: [{ productId: 'milk', sellingMethod: 'unit', remaining: 1 }] };
    const plan = async args => result(await connection.client.callTool({ name: 'plan_shufersal_replenishment', arguments: args })).result;
    try {
        const unknown = await plan({ orderNumbers: input.orderNumbers });
        assert.equal(unknown.ready, false); assert.equal(unknown.lines.find(l => l.productId === 'milk').addQuantity, null);
        const first = await plan(input);
        assert.equal(first.ready, true); assert.equal(site.writes, 0);
        assert.equal(first.lines.find(l => l.productId === 'one-off').addQuantity, 0);
        assert.equal(first.lines.find(l => l.productId === 'milk').addQuantity, 3);
        const addition = { productId: 'milk', sellingMethod: 'unit', quantity: 3, expectedRevision: first.cartRevision, operationId: randomUUID() };
        for (let i = 0; i < 2; i++) assert.equal(result(await connection.client.callTool({ name: 'add_to_shufersal_cart', arguments: addition })).ok, true);
        assert.equal(site.writes, 1);
        assert.equal((await plan(input)).lines.find(l => l.productId === 'milk').addQuantity, 0);
        assert.equal(site.current.items.find(l => l.productId === 'team-item').quantity, 9);
        site.history.push({ orderNumber: 'pending', status: 'pending', cart: structuredClone(site.current) });
        assert.equal((await plan(input)).ready, false);
    } finally { await connection.close(); }
});
