import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShoppingService } from '../dist/shopping/service.js';
import { FileJournal, acquireOwnership, SerialQueue } from '../dist/shopping/state.js';
import { revision, possibleDuplicates } from '../dist/shopping/model.js';
import { FakeSite, MemoryJournal, cart } from './helpers.mjs';
const setup = (enabled = true) => { const site = new FakeSite(); const journal = new MemoryJournal(); return { site, journal, service: new ShoppingService(site, journal, enabled) }; };
const input = site => ({ productId: 'milk', sellingMethod: 'unit', mode: 'add', quantity: 1, expectedRevision: revision(site.current), operationId: 'addition-1', comment: '' });
const code = expected => error => error.code === expected;

test('retry returns original result without repeating addition, even after restart', async () => {
    const { site, journal, service } = setup(); const request = input(site);
    const first = await service.changeQuantity(request);
    const second = await new ShoppingService(site, journal).changeQuantity(request);
    assert.deepEqual(second, first); assert.equal(site.writes, 1); assert.equal(site.current.items[0].quantity, 3);
    await assert.rejects(service.changeQuantity({ ...request, quantity: 2 }), code('OPERATION_CONFLICT'));
});
test('stale revisions and duplicate product rows block mutations', async () => {
    const { site, service } = setup(); const request = input(site); site.current.total++;
    await assert.rejects(service.changeQuantity(request), code('CART_CHANGED')); assert.equal(site.writes, 0);
    site.current.items.push({ ...site.current.items[0] });
    await assert.rejects(service.changeQuantity(input(site)), code('DUPLICATE_LINES')); assert.equal(site.writes, 0);
});
test('absolute quantity and explicit removal preserve other products', async () => {
    const { site, service } = setup(); site.current.items.push({ ...site.current.items[0], productId: 'coffee', quantity: 5 }); site.reprice();
    await service.changeQuantity({ ...input(site), mode: 'set', quantity: 4 });
    await service.changeQuantity({ ...input(site), mode: 'set', quantity: 0, operationId: 'remove' });
    assert.equal(site.current.items.length, 1); assert.equal(site.current.items[0].productId, 'coffee'); assert.equal(site.current.items[0].quantity, 5);
});
test('lost cart response persists uncertainty and blocks all new writes after restart', async () => {
    const { site, journal, service } = setup(); const request = input(site); site.failAfterWrite = true;
    await assert.rejects(service.changeQuantity(request), code('OUTCOME_UNKNOWN'));
    const restarted = new ShoppingService(site, journal);
    await assert.rejects(restarted.changeQuantity(request), code('OUTCOME_UNKNOWN'));
    await assert.rejects(restarted.changeQuantity({ ...input(site), operationId: 'new' }), code('UNRESOLVED_OPERATION'));
    assert.equal(site.writes, 1); assert.equal((await restarted.cart()).items[0].quantity, 3);
});
test('delivery selection verifies slot and catches unavailable slot before writing', async () => {
    const { site, service } = setup();
    await assert.rejects(service.selectSlot({ slotId: 'gone', expectedRevision: revision(site.current), operationId: 'slot' }), code('SLOT_UNAVAILABLE'));
    const result = await service.selectSlot({ slotId: 'slot-1', expectedRevision: revision(site.current), operationId: 'slot' });
    assert.equal(result.delivery.id, 'slot-1');
});
test('checkout disabled by default, changed totals and active duplicates prevent purchase', async () => {
    const { site, service } = setup(false); const request = { expectedRevision: revision(site.current), operationId: 'checkout', confirmed: true };
    await assert.rejects(service.submit(request), code('CHECKOUT_DISABLED'));
    const enabled = new ShoppingService(site, new MemoryJournal(), true); site.current.total++;
    await assert.rejects(enabled.submit(request), code('CART_CHANGED'));
    site.history.push({ orderNumber: 'existing', status: 'pending', cart: cart() });
    await assert.rejects(enabled.submit({ ...request, expectedRevision: revision(site.current) }), code('POSSIBLE_DUPLICATE_ORDER'));
    assert.equal(site.submits, 0);
});
test('checkout verifies a new order number and duplicate clicks cannot purchase again', async () => {
    const { site, service } = setup(); const request = { expectedRevision: revision(site.current), operationId: 'checkout', confirmed: true };
    assert.equal((await service.submit(request)).orderNumber, 'order-1');
    assert.equal((await service.submit(request)).orderNumber, 'order-1'); assert.equal(site.submits, 1);
});
test('lost checkout response reconciles from history after restart without resubmitting', async () => {
    const { site, journal, service } = setup(); site.failAfterWrite = true;
    await assert.rejects(service.submit({ expectedRevision: revision(site.current), operationId: 'checkout', confirmed: true }), code('OUTCOME_UNKNOWN'));
    const restarted = new ShoppingService(site, journal, true);
    assert.equal((await restarted.reconcileCheckout('checkout')).orderNumber, 'order-1'); assert.equal(site.submits, 1);
});
test('empty, mismatched and ambiguous order history never authorize a checkout retry', async () => {
    const { site, journal, service } = setup(); site.submit = async () => { site.submits++; };
    await assert.rejects(service.submit({ expectedRevision: revision(site.current), operationId: 'checkout', confirmed: true }), code('OUTCOME_UNKNOWN'));
    await assert.rejects(service.reconcileCheckout('checkout'), code('OUTCOME_UNKNOWN'));
    site.history = [{ orderNumber: 'wrong', status: 'confirmed', cart: { ...cart(), total: 900 } }];
    await assert.rejects(service.reconcileCheckout('checkout'), code('OUTCOME_UNKNOWN'));
    site.history = ['one', 'two'].map(orderNumber => ({ orderNumber, status: 'confirmed', cart: cart() }));
    await assert.rejects(service.reconcileCheckout('checkout'), code('OUTCOME_UNKNOWN'));
    assert.equal((await journal.load()).checkout.status, 'pending'); assert.equal(site.submits, 1);
});
test('estimated totals, expired slots and unavailable history block checkout', async () => {
    const { site, service } = setup(); site.current.estimated = true;
    await assert.rejects(service.submit({ expectedRevision: revision(site.current), operationId: 'checkout', confirmed: true }), code('INCOMPLETE_CHECKOUT'));
    site.current.estimated = false; site.current.delivery.start = '2020-01-01T10:00:00+02:00'; site.current.delivery.end = '2020-01-01T12:00:00+02:00';
    await assert.rejects(service.submit({ expectedRevision: revision(site.current), operationId: 'checkout', confirmed: true }), code('SLOT_EXPIRED'));
    site.readOrders = async () => { throw Error('unavailable'); };
    await assert.rejects(service.submit({ expectedRevision: revision(site.current), operationId: 'checkout', confirmed: true })); assert.equal(site.submits, 0);
});
test('duplicate order comparison uses Israel delivery dates across UTC midnight', () => {
    const current = cart(); current.delivery.start = '2099-10-19T22:30:00Z'; current.delivery.end = '2099-10-20T02:00:00Z';
    assert.deepEqual(possibleDuplicates(current, [{ orderNumber: 'existing', status: 'confirmed', cart: cart() }]), ['existing']);
});
test('queue serializes concurrent actions and recovers after rejection', async () => {
    const queue = new SerialQueue(); const events = [];
    const first = queue.run(async () => { events.push(1); await new Promise(resolve => setTimeout(resolve, 20)); events.push(2); throw Error('failure'); });
    const second = queue.run(async () => { events.push(3); });
    await Promise.allSettled([first, second]); assert.deepEqual(events, [1, 2, 3]);
});
test('file journal survives reload and ownership is exclusive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shufersal-state-test-'));
    try {
        const release = await acquireOwnership(directory);
        await assert.rejects(acquireOwnership(directory), code('ACCOUNT_LOCKED'));
        const journal = new FileJournal(directory);
        await journal.save({ operation: { fingerprint: 'hash', kind: 'cart', status: 'pending' } });
        assert.equal((await new FileJournal(directory).load()).operation.status, 'pending');
        assert.ok((await readFile(join(directory, 'operations.json'), 'utf8')).includes('pending'));
        await release(); const releaseAgain = await acquireOwnership(directory); await releaseAgain();
    } finally { await rm(directory, { recursive: true, force: true }); }
});


test('uncertain cart writes reconcile after restart without repeating the mutation', async () => {
    const { site, journal, service } = setup(); site.failAfterWrite = true;
    const request = input(site);
    await assert.rejects(service.changeQuantity(request), code('OUTCOME_UNKNOWN'));
    const restarted = new ShoppingService(site, journal);
    site.current.items.push({ ...site.current.items[0], productId: 'team-addition' });
    await assert.rejects(restarted.reconcileCart(request.operationId), code('OUTCOME_UNKNOWN'));
    site.current.items.pop();
    const result = await restarted.reconcileCart(request.operationId);
    assert.equal(result.quantity, 3); assert.equal(site.writes, 1);
    assert.deepEqual(await restarted.changeQuantity(request), result); assert.equal(site.writes, 1);
});

test('cart mutation tolerates a transient read failure without writing twice', async () => {
    const { site, service } = setup(); const read = site.readCart.bind(site); let reads = 0;
    site.readCart = async () => { if (++reads === 2) throw Error('transient'); return read(); };
    const result = await service.changeQuantity(input(site));
    assert.equal(result.quantity, 3); assert.equal(site.writes, 1); assert.equal(reads, 3);
});


test('unverified live capabilities fail before recording or attempting a write', async () => {
    const { site, journal, service } = setup(); site.capabilities = {selectSlot:false,submit:false};
    await assert.rejects(service.selectSlot({slotId:'slot-1',expectedRevision:revision(site.current),operationId:'slot'}),code('DELIVERY_SELECTION_NOT_VERIFIED'));
    await assert.rejects(service.submit({expectedRevision:revision(site.current),operationId:'checkout',confirmed:true}),code('LIVE_CHECKOUT_NOT_VERIFIED'));
    assert.deepEqual(await journal.load(),{}); assert.equal(site.writes,0); assert.equal(site.submits,0);
});


test('replenishment rejects duplicate or foreign baselines and requires review of fractional unit targets', async () => {
    const { site, service } = setup();
    site.history = [3, 4].map((amount, i) => { const baseline = cart(); baseline.items[0].quantity = amount; return { orderNumber: String(i), status: 'delivered', cart: baseline }; });
    const input = { orderNumbers: ['0', '1'], unlistedStockIsEmpty: true };
    const plan = await service.planReplenishment(input);
    assert.equal(plan.lines[0].target, 3.5); assert.equal(plan.ready, false);
    const override = await service.planReplenishment({ ...input, stock: [{ productId: 'milk', sellingMethod: 'unit', remaining: 10, target: 4 }] });
    assert.equal(override.ready, true); assert.equal(override.lines[0].addQuantity, 0);
    await assert.rejects(service.planReplenishment({ ...input, orderNumbers: ['0', '0'] }), code('DUPLICATE_INPUT'));
    await assert.rejects(service.planReplenishment({ ...input, stock: [{ productId: 'unknown', sellingMethod: 'unit', remaining: 0 }] }), code('UNKNOWN_STOCK_PRODUCT'));
    site.history[0].cart.accountId = 'other-account';
    await assert.rejects(service.planReplenishment(input), code('INVALID_BASELINE'));
    assert.equal(site.writes, 0);
});

test('quantity recovery ignores unavailable or refreshed money while preserving the durable pending operation', async () => {
    const { site, journal, service } = setup();
    site.current.items.push({ ...site.current.items[0], productId: 'team-product', quantity: 4 });site.reprice();
    const request = input(site);site.failAfterWrite=true;
    await assert.rejects(service.changeQuantity(request), code('OUTCOME_UNKNOWN'));
    const saved = structuredClone(journal.entries[request.operationId]);
    site.current.total=null;site.current.deliveryFee=null;
    for(const row of site.current.items) {row.unitPrice=null;row.lineTotal=null;}
    const restarted = new ShoppingService(site,journal,true);
    assert.equal((await restarted.cart()).items[0].quantity,3);
    assert.equal((await restarted.reconcileCart(request.operationId)).quantity,3);
    assert.equal(site.writes,1);
    assert.deepEqual(journal.entries[request.operationId].cartBefore,saved.cartBefore);
    assert.equal(journal.entries[request.operationId].fingerprint,saved.fingerprint);
    assert.equal((await restarted.changeQuantity(request)).quantity,3);assert.equal(site.writes,1);
    await assert.rejects(restarted.prepareCheckout(),code('INCOMPLETE_CHECKOUT'));
    await assert.rejects(restarted.submit({expectedRevision:(await restarted.cart()).revision,operationId:'checkout-missing',confirmed:true}),code('INCOMPLETE_CHECKOUT'));
    assert.equal(site.submits,0);
});

test('quantity recovery keeps uncertainty for incomplete, duplicate or changed non-monetary cart rows', async () => {
    const { site,journal,service }=setup();
    site.current.items.push({...site.current.items[0],productId:'team',quantity:4});site.reprice();
    site.failAfterWrite=true;const request=input(site);
    await assert.rejects(service.changeQuantity(request),code('OUTCOME_UNKNOWN'));
    const after=structuredClone(site.current);
    for(const change of [
        current=>current.items.pop(),
        current=>current.items.push({...current.items[1]}),
        current=>{current.items[1].quantity=7;},
        current=>{current.items[0].quantity=2;},
        current=>{current.accountId='different';},
        current=>{current.items[1].productId='different';},
        current=>{current.items[1].quantity=undefined;},
    ]) {
        site.current=structuredClone(after);change(site.current);
        await assert.rejects(service.reconcileCart(request.operationId),code('OUTCOME_UNKNOWN'));
        assert.equal(journal.entries[request.operationId].status,'pending');assert.equal(site.writes,1);
    }
    await assert.rejects(service.changeQuantity({...request,operationId:'another'}),code('UNRESOLVED_OPERATION'));
    site.current=structuredClone(after);site.current.items[1].unitPrice=9;site.current.items[1].lineTotal=36;
    assert.equal((await service.reconcileCart(request.operationId)).quantity,3);assert.equal(site.writes,1);
});

test('missing monetary data permits guarded cart verification but never a purchase-ready summary', async () => {
    const {site,service}=setup();
    const add=site.add.bind(site);
    site.add=async (...args)=>{await add(...args);site.current.total=null;site.current.items[0].lineTotal=null;};
    assert.equal((await service.changeQuantity(input(site))).quantity,3);
    await assert.rejects(service.prepareCheckout(),code('INCOMPLETE_CHECKOUT'));
    site.current.total=31;site.current.items[0].lineTotal=21;
    assert.equal((await service.prepareCheckout()).cart.total,31);
});
