import { revision } from '../dist/shopping/model.js';
export const slot = { id: 'slot-1', start: '2099-10-20T10:00:00+03:00', end: '2099-10-20T12:00:00+03:00' };
export function cart() {
    return { accountId: 'fixture-account', items: [{ productId: 'milk', sellingMethod: 'unit', name: 'Milk', unit: '1 litre', quantity: 2, unitPrice: 7, lineTotal: 14, substitution: 'none' }],
        address: 'Fixture office', delivery: structuredClone(slot), deliveryFee: 10, total: 24, currency: 'ILS', estimated: false };
}
export class MemoryJournal {
    entries = {};
    async load() { return structuredClone(this.entries); }
    async save(entries) { this.entries = structuredClone(entries); }
}
export class FakeSite {
    current = { ...cart(), integrity: { complete: true, cartId: 'active' } }; history = []; writes = 0; submits = 0; failAfterWrite = false;
    async open() { return { opened: true }; }
    async search(query) { return { results: [{ code: query }] }; }
    async readCart() { return structuredClone(this.current); }
    async describeProduct(key) { return { ...key, name: 'Fixture product', available: true, identity: { barcode: null, variant: null, packSize: null, equivalenceKeys: ['sku:' + key.productId] } }; }
    async readOrders() { return structuredClone(this.history); }
    async readSlots() { return [slot]; }
    async add(key, amount) {
        this.writes++;
        const line = this.current.items.find(item => item.productId === key.productId && item.sellingMethod === key.sellingMethod);
        if (line) line.quantity += amount;
        else this.current.items.push({ ...key, name: 'Fixture product', unit: 'unit', quantity: amount, unitPrice: 3, lineTotal: 3 * amount, substitution: 'none' });
        this.reprice();
        if (this.failAfterWrite) throw Error('sensitive secret must not escape');
    }
    async setQuantity(key, quantity) {
        this.writes++;
        this.current.items = this.current.items.flatMap(line => line.productId === key.productId && line.sellingMethod === key.sellingMethod ? quantity ? [{ ...line, quantity }] : [] : [line]);
        this.reprice();
    }
    reprice() {
        for (const line of this.current.items) line.lineTotal = line.quantity * line.unitPrice;
        this.current.total = this.current.items.reduce((sum, line) => sum + line.lineTotal, this.current.deliveryFee);
    }
    async selectSlot(id) { this.writes++; this.current.delivery = { ...slot, id }; }
    async submit(expectedRevision) {
        if (revision(this.current) !== expectedRevision) throw Error('changed');
        this.submits++;
        this.history.push({ orderNumber: 'order-1', status: 'confirmed', cart: structuredClone(this.current) });
        if (this.failAfterWrite) throw Error('response lost');
    }
}
