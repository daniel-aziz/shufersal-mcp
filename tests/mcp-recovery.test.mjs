import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ShoppingService } from '../dist/shopping/service.js';
import { FileJournal } from '../dist/shopping/state.js';
import { recoveryAdditionId } from '../dist/shopping/recovery.js';
import { revision } from '../dist/shopping/model.js';
import { registerShoppingTools } from '../dist/tools/shopping.js';
import { FakeSite, MemoryJournal } from './helpers.mjs';

const code = value => error => error.code === value;
const target = { productId: 'milk', sellingMethod: 'unit', quantity: 12 };
async function fixture(journal = new MemoryJournal()) {
    const site = new FakeSite(); site.current.items[0].quantity = 6;
    site.current.items.push({ ...site.current.items[0], productId: 'team', quantity: 4 }); site.reprice();
    const service = new ShoppingService(site, journal);
    const request = { productId: 'milk', sellingMethod: 'unit', quantity: 6, mode: 'add', comment: '', operationId: randomUUID(), expectedRevision: revision(site.current) };
    const add = site.add.bind(site); site.add = async () => { throw Error('never dispatched'); };
    await assert.rejects(service.changeQuantity(request), code('OUTCOME_UNKNOWN')); site.add = add;
    site.current.items[1].quantity = 8; site.reprice();
    const input = { operationId: request.operationId, resolutionId: randomUUID(), expectedRevision: revision(site.current), reason: 'Owner accepts current stock and keeps target 12', targets: [target],
        ownerApproval: { confirmed: true, owner: 'fixture-owner', approvalReference: 'fixture-message-42', acceptsUnknownOutcome: true, outstandingRequestsInvestigated: true } };
    const resume = { operationId: input.operationId, resolutionId: input.resolutionId, productId: target.productId, sellingMethod: target.sellingMethod, expectedRevision: input.expectedRevision };
    return { site, service, journal, request, input, resume };
}

test('MCP owner review and acceptance are explicit, serialized, durable and never mutate the cart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-recovery-'));
    const f = await fixture(new FileJournal(directory));
    const server = new McpServer({ name: 'recovery-test', version: '1' }); registerShoppingTools(server, f.service);
    const client = new Client({ name: 'owner-client', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
    try {
        const original = structuredClone((await f.journal.load())[f.input.operationId]);
        const prepared = await call('prepare_shufersal_cart_recovery', { operationId: f.input.operationId, targets: [target] });
        assert.equal(prepared.result.targets[0].missingQuantity, 6); assert.equal(prepared.result.cart.items[1].quantity, 8);
        assert.equal((await f.journal.load())[f.input.operationId].status, 'pending');
        assert.equal((await client.callTool({ name: 'accept_shufersal_cart_recovery', arguments: { ...f.input, ownerApproval: { ...f.input.ownerApproval, confirmed: false } } })).isError, true);
        const accepted = await call('accept_shufersal_cart_recovery', f.input);
        assert.equal(accepted.ok, true); assert.equal(accepted.result.historicalOutcome, 'unknown'); assert.equal(f.site.writes, 0);
        const reloaded = new FileJournal(directory); const saved = (await reloaded.load())[f.input.operationId];
        assert.equal(saved.status, 'resolved_by_operator');
        for (const [key, value] of Object.entries(original)) if (key !== 'status') assert.deepEqual(saved[key], value);
        const restarted = new ShoppingService(f.site, reloaded);
        assert.deepEqual(await restarted.acceptOwnerRecovery(f.input), accepted.result);
        await assert.rejects(restarted.acceptOwnerRecovery({ ...f.input, targets: [{ ...target, quantity: 24 }] }), code('RESOLUTION_CONFLICT'));
        assert.equal((await restarted.changeQuantity(f.request)).status, 'resolved_by_operator');
        const [first, duplicate] = await Promise.all([call('resume_shufersal_cart_recovery', f.resume), call('resume_shufersal_cart_recovery', f.resume)]);
        assert.equal(first.ok, true); assert.equal(duplicate.ok, true); assert.equal(f.site.writes, 1); assert.equal(f.site.current.items[0].quantity, 12);
        assert.equal(f.site.current.items[1].quantity, 8);
        await restarted.resumeOwnerRecovery(f.resume); assert.equal(f.site.writes, 1);
        await assert.rejects(restarted.submit({ expectedRevision: revision(f.site.current), operationId: randomUUID(), confirmed: true }), code('CHECKOUT_DISABLED'));
    } finally { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('changed recovery snapshots, incomplete reads and duplicate targets cannot be accepted', async () => {
    for (const change of [
        site => { site.current.items[0].quantity = 10; site.reprice(); },
        site => { site.current.items[1].quantity = 9; site.reprice(); },
        site => { site.current.accountId = 'different'; },
        site => { site.current.items[0].quantity = undefined; },
        site => { site.current.items.push({ ...site.current.items[0] }); },
    ]) {
        const f = await fixture(); const before = structuredClone(f.journal.entries);
        // Change between the two fresh reads inside acceptance, not merely before it.
        const read = f.site.readCart.bind(f.site); let calls = 0;
        f.site.readCart = async () => { if (++calls === 2) change(f.site); return read(); };
        await assert.rejects(f.service.acceptOwnerRecovery(f.input));
        assert.deepEqual(f.journal.entries, before); assert.equal(f.site.writes, 0);
    }
    const f = await fixture();
    await assert.rejects(f.service.prepareOwnerRecovery({ operationId: f.input.operationId, targets: [target, target] }));
    f.site.readCart = async () => { throw Error('incomplete page'); };
    await assert.rejects(f.service.prepareOwnerRecovery({ operationId: f.input.operationId, targets: [target] }));
    await assert.rejects(f.service.acceptOwnerRecovery(f.input)); assert.equal(f.site.writes, 0);
});

test('resume refreshes concurrent edits, adds only missing quantities and never removes excess or unrelated products', async () => {
    for (const actual of [8, 15]) {
        const f = await fixture(); await f.service.acceptOwnerRecovery(f.input);
        f.site.current.items[0].quantity = actual; f.site.current.items[1].quantity = 11; f.site.reprice();
        await assert.rejects(f.service.resumeOwnerRecovery(f.resume), code('CART_CHANGED')); assert.equal(f.site.writes, 0);
        await f.service.resumeOwnerRecovery({ ...f.resume, expectedRevision: revision(f.site.current) });
        assert.equal(f.site.current.items[0].quantity, Math.max(12, actual)); assert.equal(f.site.current.items[1].quantity, 11);
        assert.equal(f.site.writes, actual < 12 ? 1 : 0);
        f.site.current.items[0].quantity = 3; f.site.reprice();
        await f.service.resumeOwnerRecovery({ ...f.resume, expectedRevision: revision(f.site.current) });
        assert.equal(f.site.current.items[0].quantity, 3); // Old approval never starts a second replenishment.
    }
    const f = await fixture(); await f.service.acceptOwnerRecovery(f.input);
    const read = f.site.readCart.bind(f.site); let calls = 0;
    f.site.readCart = async () => { if (++calls === 2) { f.site.current.items[0].quantity = 9; f.site.reprice(); } return read(); };
    await assert.rejects(f.service.resumeOwnerRecovery(f.resume), code('CART_CHANGED')); assert.equal(f.site.writes, 0);
});

test('lost responses and concurrent edits during readback preserve pending child attempts across restart without replay', async () => {
    for (const outcome of ['applied-response-lost', 'never-written', 'unrelated-edit', 'target-edit', 'incomplete-readback']) {
        const f = await fixture(); await f.service.acceptOwnerRecovery(f.input);
        const add = f.site.add.bind(f.site);
        f.site.add = async (...args) => {
            if (outcome === 'never-written') throw Error('not sent');
            await add(...args);
            if (outcome === 'applied-response-lost') throw Error('lost');
            if (outcome === 'incomplete-readback') { f.site.readCart = async () => { throw Error('incomplete cart'); }; return; }
            f.site.current.items[outcome === 'target-edit' ? 0 : 1].quantity += 1; f.site.reprice();
        };
        await assert.rejects(f.service.resumeOwnerRecovery(f.resume), code('OUTCOME_UNKNOWN'));
        const child = recoveryAdditionId(f.input.resolutionId, target);
        assert.equal(f.journal.entries[child].status, 'pending');
        const writes = f.site.writes; const restarted = new ShoppingService(f.site, f.journal);
        await assert.rejects(restarted.resumeOwnerRecovery({ ...f.resume, expectedRevision: revision(f.site.current) }), code('OUTCOME_UNKNOWN'));
        assert.equal(f.site.writes, writes);
        f.site.readCart = FakeSite.prototype.readCart.bind(f.site);
        const assessment = await restarted.prepareOwnerRecovery({ operationId: child, targets: [target] });
        assert.equal(assessment.historicalOutcome, 'unknown');
        assert.equal(f.journal.entries[f.input.operationId].status, 'resolved_by_operator');
    }
});

test('other pending operations block resume and owner targets cannot be broadened through resume arguments', async () => {
    const f = await fixture(); await f.service.acceptOwnerRecovery(f.input);
    await assert.rejects(f.service.resumeOwnerRecovery({ ...f.resume, productId: 'team' }), code('TARGET_NOT_APPROVED'));
    await assert.rejects(f.service.resumeOwnerRecovery({ ...f.resume, quantity: 100 }));
    f.journal.entries[randomUUID()] = { fingerprint: 'pending', kind: 'checkout', status: 'pending' };
    await assert.rejects(f.service.resumeOwnerRecovery(f.resume), code('UNRESOLVED_OPERATION')); assert.equal(f.site.writes, 0);
});
