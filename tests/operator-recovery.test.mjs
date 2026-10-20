import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ShoppingService } from '../dist/shopping/service.js';
import { FileJournal } from '../dist/shopping/state.js';
import { revision } from '../dist/shopping/model.js';
import { FakeSite, MemoryJournal } from './helpers.mjs';

const approval = { actor: 'local:fixture:uid:501', channel: 'local_terminal', workersStopped: true, requestsInvestigated: true, acceptsUnknownOutcome: true };
const code = expected => error => error.code === expected;
async function fixture(journal = new MemoryJournal()) {
    const site = new FakeSite(); site.current.items[0].quantity = 6;
    site.current.items.push({ ...site.current.items[0], productId: 'team', quantity: 4 }); site.reprice();
    const request = { productId: 'milk', sellingMethod: 'unit', quantity: 6, mode: 'add', comment: '', operationId: randomUUID(), expectedRevision: revision(site.current) };
    site.add = async () => { throw Error('response unavailable'); };
    const service = new ShoppingService(site, journal);
    await assert.rejects(service.changeQuantity(request), code('OUTCOME_UNKNOWN'));
    site.current.items[1].quantity = 8; site.reprice();
    const input = { operationId: request.operationId, resolutionId: randomUUID(), expectedRevision: revision(site.current), reason: 'Keep current stock and retire the old increase.' };
    return { site, journal, request, input, service };
}

test('operator acceptance survives restart, retains history and permanently retires the original add without changing the cart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'recovery-ledger-'));
    try {
        const f = await fixture(new FileJournal(directory));
        const records = await f.journal.load(); records[f.request.operationId].legacyEvidence = { untouched: true };
        records[f.request.operationId].cartBefore.revision = f.request.expectedRevision;
        records[f.request.operationId].cartBefore.items[0].legacyLineEvidence = 'preserve';
        records[f.request.operationId].cartBefore.delivery.legacySlotEvidence = 'preserve';
        await f.journal.save(records);
        const original = structuredClone(records[f.request.operationId]); const before = structuredClone(f.site.current);
        const assessment = await f.service.assessCartOperation(f.request.operationId);
        assert.equal(assessment.historicalOutcome, 'unknown');assert.equal(assessment.automaticReplayAllowed, false);
        assert.deepEqual(assessment.changedUnrelatedQuantities, [{ productId: 'team', sellingMethod: 'unit', beforeQuantity: 4, currentQuantity: 8 }]);
        assert.equal(assessment.beforeQuantity, 6); assert.equal(assessment.currentQuantity, 6); assert.equal(assessment.targetQuantity, 12);
        assert.deepEqual(await f.journal.load(), records);
        const operator = new ShoppingService(f.site, f.journal, false, async () => approval);
        const resolution = await operator.acceptCurrentCartState(f.input);
        assert.equal(resolution.historicalOutcome, 'unknown'); assert.equal(resolution.observedQuantity, 6); assert.equal(resolution.targetQuantity, 12);
        assert.deepEqual(resolution.approval, approval);
        const reloaded = new FileJournal(directory);
        const retired = (await reloaded.load())[f.request.operationId];
        for (const [key, value] of Object.entries(original)) if (key !== 'status') assert.deepEqual(retired[key], value);
        assert.equal(retired.status, 'resolved_by_operator');
        const restarted = new ShoppingService(f.site, reloaded, false, async () => { throw Error('should not ask twice'); });
        assert.deepEqual(await restarted.acceptCurrentCartState(f.input), resolution);
        assert.equal((await restarted.changeQuantity(f.request)).status, 'resolved_by_operator');
        assert.equal((await restarted.reconcileCart(f.request.operationId)).status, 'resolved_by_operator');
        assert.deepEqual(f.site.current, before); assert.equal(f.site.writes, 0);
        assert.equal((await restarted.changeQuantity({ ...f.request, operationId: randomUUID(), expectedRevision: revision(f.site.current), mode: 'set', quantity: 6 })).quantity, 6);
        assert.equal(f.site.writes, 0);
        await assert.rejects(restarted.acceptCurrentCartState({ ...f.input, reason: 'different' }), code('RESOLUTION_CONFLICT'));
        const final = await reloaded.load();
        const second = randomUUID(); final[second] = { ...original, status: 'pending' }; await reloaded.save(final);
        await assert.rejects(restarted.acceptCurrentCartState({ ...f.input, operationId: second }), code('RESOLUTION_CONFLICT'));
        await assert.rejects(restarted.changeQuantity({ ...f.request, operationId: randomUUID(), expectedRevision: revision(f.site.current) }), code('UNRESOLVED_OPERATION'));
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recovery requires trusted host approval and cannot accept caller-supplied actor or acknowledgement', async () => {
    const f = await fixture(); const before = structuredClone(f.journal.entries);
    await assert.rejects(f.service.acceptCurrentCartState(f.input), code('OPERATOR_APPROVAL_UNAVAILABLE'));
    const reject = new ShoppingService(f.site, f.journal, false, async () => ({ ...approval, acceptsUnknownOutcome: false }));
    await assert.rejects(reject.acceptCurrentCartState(f.input));
    const operator = new ShoppingService(f.site, f.journal, false, async () => approval);
    await assert.rejects(operator.acceptCurrentCartState({ ...f.input, actor: 'invented', confirmed: true }));
    assert.deepEqual(f.journal.entries, before); assert.equal(f.site.writes, 0);
});

test('stale or concurrently changed carts and accounts require fresh operator review', async () => {
    for (const change of [
        site => { site.current.items[0].quantity = 12; site.reprice(); },
        site => { site.current.items[1].quantity = 9; site.reprice(); },
        site => { site.current.accountId = 'other'; },
    ]) {
        const f = await fixture(); const before = structuredClone(f.journal.entries);
        const operator = new ShoppingService(f.site, f.journal, false, async () => { change(f.site); return approval; });
        await assert.rejects(operator.acceptCurrentCartState(f.input), error => ['CART_CHANGED', 'ACCOUNT_CHANGED'].includes(error.code));
        assert.deepEqual(f.journal.entries, before); assert.equal(f.site.writes, 0);
    }
    const f = await fixture(); let asked = false;
    const operator = new ShoppingService(f.site, f.journal, false, async () => { asked = true; return approval; });
    await assert.rejects(operator.acceptCurrentCartState({ ...f.input, expectedRevision: '0'.repeat(64) }), code('CART_CHANGED'));
    assert.equal(asked, false);
});

test('recovery never resolves checkout/delivery or incomplete cart evidence and detects concurrent ledger edits', async () => {
    const f = await fixture(); const operator = new ShoppingService(f.site, f.journal, false, async () => approval);
    for (const kind of ['delivery', 'checkout']) {
        f.journal.entries[f.request.operationId].kind = kind;
        await assert.rejects(operator.acceptCurrentCartState(f.input), code('NOT_PENDING_CART'));
    }
    f.journal.entries[f.request.operationId].kind = 'cart';
    const cart = structuredClone(f.site.current);f.site.current.items[0].quantity = undefined;
    await assert.rejects(operator.acceptCurrentCartState(f.input));f.site.current = structuredClone(cart);
    f.site.current.items.push({ ...f.site.current.items[0] });
    await assert.rejects(operator.acceptCurrentCartState(f.input), code('DUPLICATE_LINES'));f.site.current = structuredClone(cart);
    const concurrent = new ShoppingService(f.site, f.journal, false, async () => { f.journal.entries[f.request.operationId].extraEvidence = 'new'; return approval; });
    await assert.rejects(concurrent.acceptCurrentCartState(f.input), code('STATE_CHANGED'));
    assert.equal(f.journal.entries[f.request.operationId].status, 'pending');assert.equal(f.site.writes, 0);
});

test('persistence failure blocks further writes, including when save failed after recording the resolution', async () => {
    for (const savedFirst of [false, true]) {
        const f = await fixture(); const save = f.journal.save.bind(f.journal);
        f.journal.save = async entries => { if (savedFirst) await save(entries); throw Error('disk failure'); };
        const operator = new ShoppingService(f.site, f.journal, false, async () => approval);
        await assert.rejects(operator.acceptCurrentCartState(f.input), code('STATE_UNREADABLE'));
        await assert.rejects(operator.changeQuantity({ ...f.request, operationId: randomUUID() }), code('STATE_UNREADABLE'));
        await assert.rejects(operator.acceptCurrentCartState(f.input), code('STATE_UNREADABLE'));
        assert.equal(f.journal.entries[f.request.operationId].status, savedFirst ? 'resolved_by_operator' : 'pending');
        assert.equal(f.site.writes, 0);
    }
});

test('a terminal status without matching audit evidence fails closed when reloading the ledger', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'recovery-invalid-'));
    try {
        const f = await fixture(new FileJournal(directory));
        const records = await f.journal.load(); records[f.request.operationId].status = 'resolved_by_operator';
        await writeFile(join(directory, 'operations.json'), JSON.stringify(records));
        await assert.rejects(f.journal.load(), code('STATE_UNREADABLE'));
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('operator command rejects piped confirmation before accessing configuration or ledger', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'recovery-cli-'));
    try {
        const ledger = join(directory, 'operations.json');await writeFile(ledger, '{"sentinel":true}');
        await assert.rejects(promisify(execFile)(process.execPath, ['dist/recover-cart.js', '--operation', randomUUID()], {
            env: { ...process.env, SHUFERSAL_STATE_DIR: directory, SHUFERSAL_CONFIG_FILE: join(directory, 'absent.json') },
        }), error => error.stderr.includes('OPERATOR_TERMINAL_REQUIRED'));
        assert.equal(await readFile(ledger, 'utf8'), '{"sentinel":true}');
    } finally { await rm(directory, { recursive: true, force: true }); }
});
