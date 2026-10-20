import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShoppingService } from '../dist/shopping/service.js';
import { revision } from '../dist/shopping/model.js';
import { FakeSite, MemoryJournal } from './helpers.mjs';

const operationId = 'fixture-uncertain-yogurt';
const code = expected => error => error.code === expected;
async function pending(applied) {
    const site = new FakeSite(); const journal = new MemoryJournal();
    site.current.items[0].quantity = 6;
    for (const productId of ['unrelated-a', 'unrelated-b']) site.current.items.push({ ...site.current.items[0], productId, quantity: 4 });
    site.reprice();
    const request = { productId: 'milk', sellingMethod: 'unit', quantity: 6, mode: 'add', comment: '', expectedRevision: revision(site.current), operationId };
    if (applied) site.failAfterWrite = true;
    else site.add = async () => { throw Error('fixture failure before any cart change'); };
    const service = new ShoppingService(site, journal);
    await assert.rejects(service.changeQuantity(request), code('OUTCOME_UNKNOWN'));
    return { site, journal, request, service: new ShoppingService(site, journal) };
}

test('response loss after application reconciles the observed target once without repeating the write', async () => {
    const { site, journal, request, service } = await pending(true);
    const original = structuredClone(journal.entries[operationId]);
    assert.equal((await service.reconcileCart(operationId)).quantity, 12);
    assert.equal((await service.changeQuantity(request)).quantity, 12);
    assert.equal(site.writes, 1);
    assert.deepEqual(journal.entries[operationId].cartBefore, original.cartBefore);
    assert.equal(journal.entries[operationId].fingerprint, original.fingerprint);
});

test('concurrent unrelated quantity edits stay untouched and do not unlock an uncertain write', async () => {
    const { site, journal, request, service } = await pending(true);
    site.current.items[1].quantity = 8; site.current.items[2].quantity = 8; site.reprice();
    const beforeRead = structuredClone(site.current); const ledger = structuredClone(journal.entries);
    await assert.rejects(service.reconcileCart(operationId), code('OUTCOME_UNKNOWN'));
    await assert.rejects(service.changeQuantity({ ...request, operationId: 'new-operation', expectedRevision: revision(site.current) }), code('UNRESOLVED_OPERATION'));
    assert.deepEqual(site.current, beforeRead); assert.deepEqual(journal.entries, ledger); assert.equal(site.writes, 1);
});

test('a write that never happened and a concurrent target edit reverting an applied write have identical evidence', async () => {
    const notApplied = await pending(false); const appliedThenReverted = await pending(true);
    appliedThenReverted.site.current.items[0].quantity = 6; appliedThenReverted.site.reprice();
    assert.deepEqual(await notApplied.service.cart(), await appliedThenReverted.service.cart());
    assert.deepEqual(notApplied.journal.entries, appliedThenReverted.journal.entries);
    for (const context of [notApplied, appliedThenReverted]) {
        const saved = structuredClone(context.journal.entries);
        await assert.rejects(context.service.reconcileCart(operationId), code('OUTCOME_UNKNOWN'));
        await assert.rejects(context.service.changeQuantity(context.request), code('OUTCOME_UNKNOWN'));
        assert.deepEqual(context.journal.entries, saved);
    }
    assert.equal(notApplied.site.writes, 0); assert.equal(appliedThenReverted.site.writes, 1);
});

test('target equality cannot attribute application when another actor can make the same target edit', async () => {
    const applied = await pending(true); const notAppliedThenEdited = await pending(false);
    notAppliedThenEdited.site.current.items[0].quantity = 12; notAppliedThenEdited.site.reprice();
    assert.deepEqual(await applied.service.cart(), await notAppliedThenEdited.service.cart());
    assert.deepEqual(applied.journal.entries, notAppliedThenEdited.journal.entries);
    assert.equal(applied.site.writes, 1); assert.equal(notAppliedThenEdited.site.writes, 0);
    // Equal observations support a current postcondition, not attribution of the original request.
    assert.equal(applied.journal.entries[operationId].status, 'pending');
    assert.equal(notAppliedThenEdited.journal.entries[operationId].status, 'pending');
});
