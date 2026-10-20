import { createHash } from "node:crypto";
import { cartSchema, orderSchema, possibleDuplicates, quantity, revision, sameProduct, ShoppingError, slotSchema, type ProductKey, type ShoppingSite } from "./model.js";
import { type Journal, SerialQueue, type Operation } from "./state.js";

export class ShoppingService {
    private readonly queue = new SerialQueue();
    constructor(private readonly site: ShoppingSite, private readonly journal: Journal, private readonly checkoutEnabled = false) {}

    run<T>(action: () => Promise<T>): Promise<T> { return this.queue.run(action); }
    async open() { return this.site.open(); }
    async search(query: string) { return this.site.search(query); }
    async cart() {
        const cart = cartSchema.parse(await this.site.readCart());
        return { ...cart, revision: revision(cart) };
    }
    async orders() { return orderSchema.array().parse(await this.site.readOrders()); }
    async slots() { return slotSchema.array().parse(await this.site.readSlots()); }
    async operation(operationId: string) {
        const entry = (await this.journal.load())[operationId];
        if (!entry) throw new ShoppingError("UNKNOWN_OPERATION", "No operation exists with this ID.");
        return entry;
    }

    private async begin(operationId: string, input: unknown, kind: Operation["kind"], extra: Partial<Operation> = {}) {
        const operations = await this.journal.load();
        const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
        const existing = operations[operationId];
        if (existing) {
            if (existing.fingerprint !== fingerprint) throw new ShoppingError("OPERATION_CONFLICT", "This operation ID was used with different arguments.");
            if (existing.status === "pending") throw new ShoppingError("OUTCOME_UNKNOWN", "Do not retry. Inspect the operation and current site state first.");
            return { operations, existing };
        }
        if (Object.values(operations).some(operation => operation.status === "pending")) {
            throw new ShoppingError("UNRESOLVED_OPERATION", "An earlier write has an unknown outcome. All new writes are blocked.");
        }
        operations[operationId] = { ...extra, fingerprint, kind, status: "pending" };
        return { operations, existing: undefined };
    }

    private async perform<T>(operationId: string, operations: Record<string, Operation>, action: () => Promise<T>): Promise<T> {
        await this.journal.save(operations);
        try {
            const result = await action();
            operations[operationId] = { ...operations[operationId], status: "complete", result };
            await this.journal.save(operations);
            return result;
        } catch {
            throw new ShoppingError("OUTCOME_UNKNOWN", "The write may have succeeded. It will not be retried automatically. Read the cart or order history and reconcile first.");
        }
    }

    async changeQuantity(input: ProductKey & { quantity: number; mode: "add" | "set"; expectedRevision: string; operationId: string; comment: string }) {
        const { operations, existing } = await this.begin(input.operationId, input, "cart");
        if (existing) return existing.result;
        const before = await this.cart();
        if (before.revision !== input.expectedRevision) throw new ShoppingError("CART_CHANGED", "Read and review the changed cart before writing.");
        const current = quantity(before, input);
        const target = input.mode === "add" ? current + input.quantity : input.quantity;
        if (input.mode === "set" && current === 0 && target > 0) throw new ShoppingError("PRODUCT_NOT_IN_CART", "Use add_to_shufersal_cart for a new product.");
        operations[input.operationId].cartBefore = before;
        operations[input.operationId].product = { productId: input.productId, sellingMethod: input.sellingMethod };
        operations[input.operationId].targetQuantity = target;
        return this.perform(input.operationId, operations, async () => {
            if (current !== target) {
                if (input.mode === "add") await this.site.add(input, input.quantity, input.comment);
                else await this.site.setQuantity(input, target);
            }
            return this.verifyCartChange(operations[input.operationId]);
        });
    }

    private async verifyCartChange(operation: Operation) {
        const { cartBefore, product, targetQuantity } = operation;
        if (!cartBefore || !product || targetQuantity === undefined) throw new ShoppingError("RECOVERY_DATA_MISSING", "This older operation needs manual inspection before recovery.");
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const after = await this.cart();
                const others = (cart: typeof cartBefore) => JSON.stringify(cart.items.filter(line => !sameProduct(line, product)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
                if (quantity(after, product) === targetQuantity && others(cartBefore) === others(after)
                    && cartBefore.accountId === after.accountId && cartBefore.address === after.address
                    && JSON.stringify(cartBefore.delivery) === JSON.stringify(after.delivery)) {
                    return { revision: after.revision, ...product, quantity: targetQuantity };
                }
            } catch { /* Retry only the read, never the mutation. */ }
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new ShoppingError("OUTCOME_UNKNOWN", "Cart read-back did not prove the intended change. Inspect and reconcile; do not repeat the write.");
    }

    async reconcileCart(operationId: string) {
        const operations = await this.journal.load();
        const operation = operations[operationId];
        if (!operation || operation.kind !== "cart") throw new ShoppingError("UNKNOWN_OPERATION", "This is not a cart operation.");
        if (operation.status === "complete") return operation.result;
        const result = await this.verifyCartChange(operation);
        operations[operationId] = { ...operation, status: "complete", result };
        await this.journal.save(operations);
        return result;
    }

    async selectSlot(input: { slotId: string; expectedRevision: string; operationId: string }) {
        if (this.site.capabilities?.selectSlot === false) throw new ShoppingError("DELIVERY_SELECTION_NOT_VERIFIED", "This adapter supports reading slots, but selection is not yet verified.");
        const { operations, existing } = await this.begin(input.operationId, input, "delivery");
        if (existing) return existing.result;
        const before = await this.cart();
        if (before.revision !== input.expectedRevision) throw new ShoppingError("CART_CHANGED", "Read and review the changed cart before selecting delivery.");
        const slot = (await this.slots()).find(candidate => candidate.id === input.slotId);
        if (!slot) throw new ShoppingError("SLOT_UNAVAILABLE", "Select a currently available delivery slot.");
        return this.perform(input.operationId, operations, async () => {
            await this.site.selectSlot(input.slotId);
            const after = await this.cart();
            if (JSON.stringify(after.delivery) !== JSON.stringify(slot)) throw new Error("Delivery not verified");
            return { revision: after.revision, delivery: after.delivery };
        });
    }

    async prepareCheckout() {
        const cart = await this.cart();
        const duplicates = possibleDuplicates(cart, await this.orders());
        return { cart, possibleDuplicateOrderNumbers: duplicates, checkoutEnabled: this.checkoutEnabled, readAt: new Date().toISOString() };
    }

    async submit(input: { expectedRevision: string; operationId: string; confirmed: true }) {
        if (!this.checkoutEnabled) throw new ShoppingError("CHECKOUT_DISABLED", "Checkout is disabled until the site adapter has been verified and checkout explicitly enabled by the operator.");
        if (this.site.capabilities?.submit === false) throw new ShoppingError("LIVE_CHECKOUT_NOT_VERIFIED", "This adapter has not verified the final purchase page. No checkout will be attempted.");
        const { operations, existing } = await this.begin(input.operationId, input, "checkout");
        if (existing) return existing.result;
        const orders = await this.orders();
        const cart = await this.cart();
        if (cart.revision !== input.expectedRevision) throw new ShoppingError("CART_CHANGED", "The checkout summary changed. Obtain approval again.");
        if (!cart.delivery || !cart.items.length || cart.estimated || !cart.address || cart.deliveryFee === null || cart.items.some(item => item.substitution === null)) throw new ShoppingError("INCOMPLETE_CHECKOUT", "Checkout requires items, a delivery window, and an exact total.");
        if (Date.parse(cart.delivery.start) <= Date.now()) throw new ShoppingError("SLOT_EXPIRED", "The delivery window is no longer valid.");
        if (possibleDuplicates(cart, orders).length) throw new ShoppingError("POSSIBLE_DUPLICATE_ORDER", "An active order already exists for this address and delivery day. Review it before checkout.");
        operations[input.operationId].checkoutRevision = input.expectedRevision;
        operations[input.operationId].previousOrders = orders.map(order => order.orderNumber);
        return this.perform(input.operationId, operations, async () => {
            await this.site.submit(input.expectedRevision);
            return this.verifyOrder(operations[input.operationId]);
        });
    }

    private async verifyOrder(operation: Operation) {
        const matches = (await this.orders()).filter(order =>
            !operation.previousOrders?.includes(order.orderNumber) &&
            (order.status === "confirmed" || order.status === "pending") &&
            revision(order.cart) === operation.checkoutRevision);
        if (matches.length !== 1) throw new ShoppingError("OUTCOME_UNKNOWN", "Order history does not identify exactly one matching new order. Do not submit again.");
        return { orderNumber: matches[0].orderNumber, status: matches[0].status };
    }

    async reconcileCheckout(operationId: string) {
        const operations = await this.journal.load();
        const operation = operations[operationId];
        if (!operation || operation.kind !== "checkout") throw new ShoppingError("UNKNOWN_OPERATION", "This is not a checkout operation.");
        if (operation.status === "complete") return operation.result;
        const result = await this.verifyOrder(operation);
        operations[operationId] = { ...operation, status: "complete", result };
        await this.journal.save(operations);
        return result;
    }
}
