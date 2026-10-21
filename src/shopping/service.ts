import { CartWriteError, sanitizedError } from "./evidence.js";
import { assessCartRecovery, ownerRecoverySchema, mcpApprovalSchema, targetsSchema, targetComparison, recoveryAdditionId, operatorApprovalSchema, recoveryFingerprint, recoveryInputSchema, resolutionSchema, type RecoveryApprover } from "./recovery.js";
import { planReplenishment, replenishmentSchema } from "./replenishment.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { cartSchema, cartContents, hasCompleteMoney, orderSchema, possibleDuplicates, quantity, revision, ShoppingError, slotSchema, productDescriptionSchema, type Cart, type ProductDescription, type ProductKey, type ShoppingSite } from "./model.js";
import { type Journal, SerialQueue, type Operation } from "./state.js";

export const batchTargetsSchema = z.object({
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    targets: z.array(z.object({ productId: z.string().min(1), sellingMethod: z.string().min(1),
        quantity: z.number().finite().nonnegative(), expectedName: z.string().min(1), operationId: z.string().uuid(),
    }).strict()).min(1).max(100),
}).strict().refine(input => new Set(input.targets.map(t => t.operationId)).size === input.targets.length
    && new Set(input.targets.map(t => t.productId.replace(/^P_/, ""))).size === input.targets.length, "Duplicate target or operation ID");

export class ShoppingService {
    private readonly queue = new SerialQueue();
    private recoveryPersistenceUncertain = false;
    constructor(private readonly site: ShoppingSite, private readonly journal: Journal, private readonly checkoutEnabled = false, private readonly approveRecovery?: RecoveryApprover) {}

    run<T>(action: () => Promise<T>): Promise<T> { return this.queue.run(action); }
    async open() { return this.site.open(); }
    async search(query: string) { return this.site.search(query); }
    async cart() {
        const cart = cartSchema.parse(await this.site.readCart());
        if (cart.integrity?.complete !== true) throw new ShoppingError("INCOMPLETE_CART", "Cart integrity is unverified; all writes are blocked.");
        for (const line of cart.items) quantity(cart, line);
        return { ...cart, revision: revision(cart) };
    }
    async orders() { return orderSchema.array().parse(await this.site.readOrders()); }
    async planReplenishment(input: unknown) {
        const parsed = replenishmentSchema.parse(input);
        const history = await this.orders();
        return planReplenishment(cartSchema.parse(await this.cart()), history, parsed);
    }
    async slots() { return slotSchema.array().parse(await this.site.readSlots()); }
    async operation(operationId: string) {
        const entry = (await this.journal.load())[operationId];
        if (!entry) throw new ShoppingError("UNKNOWN_OPERATION", "No operation exists with this ID.");
        return entry;
    }

    private async describe(cart: Cart, key: ProductKey): Promise<ProductDescription> {
        const line = cart.items.find(item => item.productId === key.productId && item.sellingMethod === key.sellingMethod);
        if (!this.site.describeProduct) throw new ShoppingError("IDENTITY_UNVERIFIED", "Exact account-context product availability must be verified before changing quantities.");
        const description = productDescriptionSchema.parse(await this.site.describeProduct(key, cart.accountId));
        if (description.productId !== key.productId || description.sellingMethod !== key.sellingMethod)
            throw new ShoppingError("PRODUCT_MISMATCH", "The returned SKU or sale unit does not match the requested product.");
        if (!line?.identity) return description;
        for (const field of ["barcode", "variant", "packSize"] as const) {
            const previous = line.identity[field];
            const current = description.identity[field];
            if (previous !== null && current !== null && previous !== current)
                throw new ShoppingError("PRODUCT_MISMATCH", "Product or pack identity conflicts with the verified cart row.");
        }
        const previousKeys = line.identity.equivalenceKeys;
        const currentKeys = description.identity.equivalenceKeys;
        if (previousKeys && currentKeys && JSON.stringify([...previousKeys].sort()) !== JSON.stringify([...currentKeys].sort()))
            throw new ShoppingError("PACK_EQUIVALENCE_REVIEW", "Fresh product equivalence conflicts with the cart; review the exact sale unit before writing.");
        return { ...description, identity: {
            barcode: description.identity.barcode ?? line.identity.barcode,
            variant: description.identity.variant ?? line.identity.variant,
            packSize: description.identity.packSize ?? line.identity.packSize,
            equivalenceKeys: currentKeys ?? previousKeys,
        } };
    }

    private assertIndependent(operations: Record<string, Operation>, cart: Cart | undefined, product: ProductDescription | undefined) {
        for (const operation of Object.values(operations).filter(op => op.status === "pending")) {
            const scope = operation.unresolved?.scope;
            if (operation.kind !== "cart" || !scope || !cart?.integrity?.complete || !product?.identity.equivalenceKeys)
                throw new ShoppingError("UNRESOLVED_OPERATION", "A pending write has unknown scope or integrity, or concerns checkout/delivery. All writes remain blocked.");
            if (scope.accountId !== cart.accountId || scope.cartId !== cart.integrity.cartId) continue;
            const key = (id: string) => id.replace(/^P_/, "");
            if (key(operation.product?.productId ?? "") === key(product.productId)
                || scope.equivalenceKeys.some(id => product.identity.equivalenceKeys!.includes(id)))
                throw new ShoppingError("SKU_OUTCOME_UNKNOWN", "This SKU or an equivalent sale unit has an unresolved write. Independent verified products may continue.");
        }
    }

    async unresolvedItems() {
        return Object.entries(await this.journal.load()).filter(([, op]) => op.status === "pending").map(([operationId, op]) => ({
            operationId, product: op.product, requestedAbsoluteTarget: op.requestedAbsoluteTarget ?? op.targetQuantity ?? null,
            lastVerifiedQuantity: op.unresolved?.lastVerifiedQuantity ?? (op.cartBefore && op.product ? quantity(op.cartBefore, op.product) : null),
            reason: op.unresolved?.reason ?? "Legacy uncertain operation: dispatch and scope evidence unavailable",
            scope: op.unresolved?.scope ?? null, historicalOutcome: "unknown", evidence: op.evidence ?? [],
        }));
    }

    private async begin(operationId: string, input: unknown, kind: Operation["kind"], extra: Partial<Operation> = {}, description?: ProductDescription) {
        if (this.recoveryPersistenceUncertain) throw new ShoppingError("STATE_UNREADABLE", "Recovery persistence was uncertain. Restart and inspect the preserved ledger before writing.");
        const operations = await this.journal.load();
        const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
        const existing = operations[operationId];
        if (existing) {
            if (existing.fingerprint !== fingerprint) throw new ShoppingError("OPERATION_CONFLICT", "This operation ID was used with different arguments.");
            if (existing.status === "pending") throw new ShoppingError("OUTCOME_UNKNOWN", "Do not retry. Inspect the operation and current site state first.");
            return { operations, existing };
        }
        this.assertIndependent(operations, kind === "cart" ? extra.cartBefore : undefined, description);
        operations[operationId] = { ...extra, fingerprint, kind, status: "pending" };
        return { operations, existing: undefined };
    }

    private async saveEvidence(operations: Record<string, Operation>) {
        try { await this.journal.save(operations); }
        catch { this.recoveryPersistenceUncertain = true; throw new ShoppingError("STATE_UNREADABLE", "Persistence is uncertain. Stop all writes and inspect the preserved ledger after restart."); }
    }

    private async perform<T>(operationId: string, operations: Record<string, Operation>, action: () => Promise<T>): Promise<T> {
        const operation = operations[operationId];
        operation.evidence = [{ at: new Date().toISOString(), stage: "prepared" }];
        await this.saveEvidence(operations);
        operation.evidence.push({ at: new Date().toISOString(), stage: "dispatch_attempted" });
        await this.saveEvidence(operations);
        let result: T;
        try { result = await action(); }
        catch (error) {
            const evidence = error instanceof CartWriteError ? error.evidence : sanitizedError(error, "dispatch_attempted", "transport");
            operation.evidence.push(evidence);
            if (error instanceof CartWriteError && evidence.stage === "not_dispatched") {
                evidence.outcome = "not_applied";
                operation.status = "not_applied";
                operation.result = { status: "not_applied", reason: evidence.reason, code: error.code };
            }
            await this.saveEvidence(operations);
            if (operation.status === "not_applied") throw new ShoppingError(error instanceof ShoppingError ? error.code : "NOT_DISPATCHED", "The adapter verified that no cart request was dispatched. The evidence is saved; do not replay this ID.");
            throw new ShoppingError("OUTCOME_UNKNOWN", `Operation ${operationId} remains unresolved. Inspect sanitized evidence and fresh state; never replay it.`);
        }
        operations[operationId] = { ...operation, status: "complete", result };
        await this.saveEvidence(operations);
        return result;
    }

    async changeQuantity(input: ProductKey & { quantity: number; mode: "add" | "set"; expectedRevision: string; operationId: string; comment: string; absoluteTarget?: number }) {
        if (this.recoveryPersistenceUncertain) throw new ShoppingError("STATE_UNREADABLE", "Restart and inspect the ledger after uncertain persistence.");
        // Handle old IDs before reading or calculating a new deficit.
        const loaded = await this.journal.load();
        const prior = loaded[input.operationId];
        if (prior) {
            const { existing } = await this.begin(input.operationId, input, "cart");
            return existing!.status === "resolved_by_operator" ? { status: existing!.status, resolution: existing!.resolution } : existing!.result;
        }
        if (Object.values(loaded).some(op => op.status === "pending" && (op.kind !== "cart" || !op.unresolved?.scope)))
            throw new ShoppingError("UNRESOLVED_OPERATION", "A pending operation has unknown scope or affects checkout/delivery. Preserve it for recovery.");
        const before = await this.cart();
        if (before.revision !== input.expectedRevision) throw new ShoppingError("CART_CHANGED", "Read and review the changed cart before writing.");
        const current = quantity(before, input);
        const target = input.absoluteTarget !== undefined ? Math.max(current, input.absoluteTarget) : input.mode === "add" ? current + input.quantity : input.quantity;
        if (!Number.isFinite(target) || target < 0) throw new ShoppingError("INVALID_QUANTITY", "Invalid absolute quantity.");
        if (input.mode === "set" && current === 0 && target > 0) throw new ShoppingError("PRODUCT_NOT_IN_CART", "Use add_to_shufersal_cart for a new product.");
        const description = await this.describe(before, input);
        if (description.available === null) throw new ShoppingError("AVAILABILITY_UNVERIFIED", "Catalog availability is unknown; no write was attempted.");
        if (description.available === false) throw new ShoppingError("PRODUCT_UNAVAILABLE", "The exact requested product is unavailable; no substitute was selected.");
        const equivalenceKeys = description.identity.equivalenceKeys;
        if (before.items.some(line => (line.productId !== input.productId || line.sellingMethod !== input.sellingMethod)
            && (line.productId.replace(/^P_/, "") === input.productId.replace(/^P_/, "") || line.identity?.equivalenceKeys?.some(key => equivalenceKeys?.includes(key)))))
            throw new ShoppingError("PACK_EQUIVALENCE_REVIEW", "An equivalent pack or sale unit is already in the cart; review the conversion rather than adding duplicates.");
        const { operations } = await this.begin(input.operationId, input, "cart", {
            cartBefore: before, product: description, targetQuantity: target, requestedAbsoluteTarget: input.absoluteTarget ?? target,
            unresolved: { reason: "Write outcome not yet verified", lastVerifiedQuantity: current,
                scope: before.integrity?.complete && equivalenceKeys ? { accountId: before.accountId, cartId: before.integrity.cartId, equivalenceKeys } : null },
        }, description);
        return this.perform(input.operationId, operations, async () => {
            let fresh;
            try { fresh = await this.cart(); }
            catch (error) { throw new CartWriteError("INCOMPLETE_CART", "Pre-dispatch cart read failed.", { ...sanitizedError(error, "not_dispatched", "incomplete_read"), outcome: "not_applied" }); }
            if (fresh.revision !== before.revision) throw new CartWriteError("CART_CHANGED", "Cart changed before dispatch.", { at: new Date().toISOString(), stage: "not_dispatched", outcome: "not_applied", reason: "precondition" });
            if (current !== target) {
                if (input.mode === "add") {
                    const evidence = await this.site.add(input, target - current, input.comment, { expectedQuantity: current, targetQuantity: target, accountId: before.accountId });
                    if (evidence) operations[input.operationId].evidence!.push(evidence);
                } else await this.site.setQuantity(input, target);
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
                const observedQuantity = after.items.some(item => item.productId === product.productId && item.sellingMethod === product.sellingMethod) || after.integrity?.complete ? quantity(after, product) : null;
                if (operation.unresolved && observedQuantity !== null) operation.unresolved.lastVerifiedQuantity = observedQuantity;
                if (observedQuantity === targetQuantity && cartContents(cartBefore, product) === cartContents(after, product)
                    && cartBefore.accountId === after.accountId && cartBefore.address === after.address
                    && JSON.stringify(cartBefore.delivery) === JSON.stringify(after.delivery)) {
                    operation.evidence?.push({ at: new Date().toISOString(), stage: "readback_verified", outcome: "verified", observedQuantity });
                    return { revision: after.revision, ...product, quantity: targetQuantity };
                } else {
                    operation.evidence?.push({ at: new Date().toISOString(), stage: "readback_unverified", reason: "readback_mismatch", observedQuantity });
                    if (operation.unresolved) operation.unresolved.reason = "Fresh readback did not verify the requested target";
                }
            } catch (error) {
                operation.evidence?.push(sanitizedError(error, "readback_unverified", "incomplete_read"));
                if (operation.unresolved) operation.unresolved.reason = "Readback incomplete or unverified";
            }
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new ShoppingError("OUTCOME_UNKNOWN", "Cart read-back did not prove the intended change. Inspect and reconcile; do not repeat the write.");
    }

    async reconcileCart(operationId: string) {
        if (this.recoveryPersistenceUncertain) throw new ShoppingError("STATE_UNREADABLE", "Restart and inspect the preserved ledger after uncertain persistence.");
        const operations = await this.journal.load();
        const operation = operations[operationId];
        if (!operation || operation.kind !== "cart") throw new ShoppingError("UNKNOWN_OPERATION", "This is not a cart operation.");
        if (operation.status === "resolved_by_operator") return { status: operation.status, resolution: operation.resolution };
        if (operation.status === "complete" || operation.status === "not_applied") return operation.result;
        let result;
        try { result = await this.verifyCartChange(operation); }
        catch (error) { await this.saveEvidence(operations); throw error; }
        operations[operationId] = { ...operation, status: "complete", result };
        await this.saveEvidence(operations);
        return result;
    }


    async assessCartOperation(operationId: string) {
        return assessCartRecovery(operationId, await this.operation(operationId), cartSchema.parse(await this.cart()));
    }

    async prepareOwnerRecovery(rawInput: unknown) {
        const input = z.object({ operationId: z.string().uuid(), targets: targetsSchema }).strict().parse(rawInput);
        const cart = cartSchema.parse(await this.cart());
        const assessment = assessCartRecovery(input.operationId, await this.operation(input.operationId), cart);
        return { ...assessment, cart, targets: targetComparison(cart, input.targets),
            approvalRequired: "Owner must explicitly approve this revision and these absolute target quantities, accept the unknown history, and investigate outstanding requests. Do not invent approval." };
    }

    async acceptOwnerRecovery(rawInput: unknown) {
        const input = ownerRecoverySchema.parse(rawInput);
        return this.acceptRecovery(input, input);
    }

    async acceptCurrentCartState(rawInput: unknown) {
        return this.acceptRecovery(rawInput);
    }

    private async acceptRecovery(rawInput: unknown, ownerRequest?: z.infer<typeof ownerRecoverySchema>) {
        return this.run(async () => {
            if (!ownerRequest && !this.approveRecovery) throw new ShoppingError("OPERATOR_APPROVAL_UNAVAILABLE", "Use the interactive local operator command; MCP cannot approve recovery.");
            if (this.recoveryPersistenceUncertain) throw new ShoppingError("STATE_UNREADABLE", "Restart and inspect the preserved ledger after uncertain persistence.");
            const input = ownerRequest ?? recoveryInputSchema.parse(rawInput);
            const operations = await this.journal.load();
            const operation = operations[input.operationId];
            if (!operation) throw new ShoppingError("UNKNOWN_OPERATION", "No operation exists with this ID.");
            const fingerprint = recoveryFingerprint(input);
            if (operation.status === "resolved_by_operator") {
                if (operation.resolution?.requestFingerprint !== fingerprint) throw new ShoppingError("RESOLUTION_CONFLICT", "This operation already has a different recorded resolution.");
                return operation.resolution;
            }
            if (Object.values(operations).some(entry => entry.resolution?.resolutionId === input.resolutionId)) throw new ShoppingError("RESOLUTION_CONFLICT", "The resolution ID is already in use.");
            const assessment = await this.assessCartOperation(input.operationId);
            if (assessment.currentRevision !== input.expectedRevision) throw new ShoppingError("CART_CHANGED", "Review a fresh assessment before accepting the current state.");
            const approval = ownerRequest
                ? mcpApprovalSchema.parse({ channel: "mcp_owner", ...ownerRequest.ownerApproval })
                : operatorApprovalSchema.parse(await this.approveRecovery!(assessment, input));
            const observedCart = cartSchema.parse(await this.cart());
            const finalAssessment = assessCartRecovery(input.operationId, operation, observedCart);
            if (finalAssessment.currentRevision !== input.expectedRevision) throw new ShoppingError("CART_CHANGED", "The cart changed during approval; obtain approval of the new state.");
            const latest = await this.journal.load();
            if (JSON.stringify(latest) !== JSON.stringify(operations)) throw new ShoppingError("STATE_CHANGED", "The operation ledger changed during approval; inspect it before continuing.");
            const resolution = resolutionSchema.parse({
                version: 1, operationId: input.operationId, resolutionId: input.resolutionId,
                decision: "accept_current_state", historicalOutcome: "unknown", recordedAt: new Date().toISOString(),
                reason: input.reason, requestFingerprint: fingerprint, reviewedRevision: input.expectedRevision,
                observedCart, beforeQuantity: assessment.beforeQuantity, targetQuantity: assessment.targetQuantity,
                observedQuantity: finalAssessment.currentQuantity, approval, ...(ownerRequest ? { ownerRequest } : {}),
            });
            operations[input.operationId] = { ...operation, status: "resolved_by_operator", resolution };
            try { await this.journal.save(operations); }
            catch {
                this.recoveryPersistenceUncertain = true;
                throw new ShoppingError("STATE_UNREADABLE", "Resolution persistence is uncertain; no cart action was taken. Restart and inspect the preserved ledger.");
            }
            return resolution;
        });
    }

    /** Caller serializes this with other MCP actions. Never replays a recorded recovery attempt. */
    async resumeOwnerRecovery(rawInput: unknown) {
        const input = z.object({ operationId: z.string().uuid(), resolutionId: z.string().uuid(),
            productId: z.string().min(1), sellingMethod: z.string().min(1), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
        }).strict().parse(rawInput);
        const original = await this.operation(input.operationId);
        const resolution = original.resolution;
        if (original.status !== "resolved_by_operator" || !resolution?.ownerRequest || resolution.resolutionId !== input.resolutionId)
            throw new ShoppingError("OWNER_RECOVERY_REQUIRED", "Accept an owner-approved baseline and targets first.");
        const target = resolution.ownerRequest.targets.find(t => t.productId === input.productId && t.sellingMethod === input.sellingMethod);
        if (!target) throw new ShoppingError("TARGET_NOT_APPROVED", "This product is not in the approved target list.");
        const additionId = recoveryAdditionId(input.resolutionId, input);
        const operations = await this.journal.load();
        const existing = operations[additionId];
        if (existing?.status === "pending") throw new ShoppingError("OUTCOME_UNKNOWN", `Recovery addition ${additionId} is uncertain. Prepare a new owner recovery for that operation; never replay it.`);
        if (existing) return { operationId: additionId, status: existing.status, result: existing.result, resolution: existing.resolution };

        const cart = await this.cart();
        if (cart.accountId !== resolution.observedCart.accountId) throw new ShoppingError("ACCOUNT_CHANGED", "The account changed since owner approval.");
        if (cart.revision !== input.expectedRevision) throw new ShoppingError("CART_CHANGED", "Read the fresh cart and reassess missing quantities before continuing.");
        const missing = targetComparison(cart, [target])[0].missingQuantity;
        // Zero is recorded too: replaying this intent later must not replenish a colleague's removal.
        try {
            const result = await this.changeQuantity({ productId: input.productId, sellingMethod: input.sellingMethod,
                operationId: additionId, expectedRevision: cart.revision, mode: "add", quantity: missing, comment: "" });
            return { operationId: additionId, result };
        } catch (error) {
            if (error instanceof ShoppingError && error.code === "OUTCOME_UNKNOWN")
                throw new ShoppingError("OUTCOME_UNKNOWN", `Recovery addition ${additionId} is uncertain. Read the cart and prepare owner recovery for this child operation. Never retry the add.`);
            throw error;
        }
    }

    async applyTargets(rawInput: unknown) {
        const input = batchTargetsSchema.parse(rawInput);
        const results: { verified: unknown[]; unresolved: unknown[]; unavailable: unknown[]; unattempted: unknown[] } = { verified: [], unresolved: [], unavailable: [], unattempted: [] };
        let first = true;
        for (const target of input.targets) {
            try {
                const cart = await this.cart();
                if (!cart.integrity?.complete) throw new ShoppingError("INCOMPLETE_CART", "A complete fresh cart is required for batch targets.");
                if (first && cart.revision !== input.expectedRevision) {
                    results.unattempted.push(...input.targets.map(item => ({ ...item, reason: "CART_CHANGED" })));
                    break;
                }
                first = false;
                const description = await this.describe(cart, target);
                if (description.name !== target.expectedName) throw new ShoppingError("PRODUCT_MISMATCH", "Exact name and SKU do not match the approved product.");
                if (description.available === null) throw new ShoppingError("AVAILABILITY_UNVERIFIED", "Catalog availability is unknown; no write was attempted.");
                if (description.available === false) throw new ShoppingError("PRODUCT_UNAVAILABLE", "The exact product is unavailable.");
                const prior = (await this.journal.load())[target.operationId];
                if (prior) {
                    if (prior.product?.productId !== target.productId || prior.product.sellingMethod !== target.sellingMethod
                        || prior.requestedAbsoluteTarget !== target.quantity) throw new ShoppingError("OPERATION_CONFLICT", "This target operation ID belongs to a different intent.");
                    if (prior.status === "pending") { results.unresolved.push({ ...target, product: description, reason: "OUTCOME_UNKNOWN" }); continue; }
                    if (prior.status !== "complete") { results.unattempted.push({ ...target, product: description, status: prior.status, reason: "RETIRED_INTENT" }); continue; }
                    results.verified.push({ ...target, product: description, result: prior.result, replayed: false }); continue;
                }
                const result = await this.changeQuantity({ productId: target.productId, sellingMethod: target.sellingMethod,
                    quantity: 0, absoluteTarget: target.quantity, mode: "add", comment: "", operationId: target.operationId, expectedRevision: cart.revision });
                results.verified.push({ ...target, product: description, result });
            } catch (error) {
                const reason = error instanceof ShoppingError ? error.code : "INCOMPLETE_CART";
                const item = { ...target, reason };
                if (["OUTCOME_UNKNOWN", "SKU_OUTCOME_UNKNOWN"].includes(reason)) results.unresolved.push(item);
                else if (reason === "PRODUCT_UNAVAILABLE") results.unavailable.push(item);
                else results.unattempted.push(item);
            }
        }
        return { ...results, pendingOperations: await this.unresolvedItems() };
    }

    async selectSlot(input: { slotId: string; expectedRevision: string; operationId: string }) {
        if (this.site.capabilities?.selectSlot === false) throw new ShoppingError("DELIVERY_SELECTION_NOT_VERIFIED", "This adapter supports reading slots, but selection is not yet verified.");
        const { operations, existing } = await this.begin(input.operationId, input, "delivery");
        if (existing) return existing.status === "resolved_by_operator" ? { status: existing.status, resolution: existing.resolution } : existing.result;
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
        if (!hasCompleteMoney(cart)) throw new ShoppingError("INCOMPLETE_CHECKOUT", "Verified prices, line totals, delivery fee and total are required before final approval.");
        const duplicates = possibleDuplicates(cart, await this.orders());
        return { cart, possibleDuplicateOrderNumbers: duplicates, checkoutEnabled: this.checkoutEnabled, readAt: new Date().toISOString() };
    }

    async submit(input: { expectedRevision: string; operationId: string; confirmed: true }) {
        if (!this.checkoutEnabled) throw new ShoppingError("CHECKOUT_DISABLED", "Checkout is disabled until the site adapter has been verified and checkout explicitly enabled by the operator.");
        if (this.site.capabilities?.submit === false) throw new ShoppingError("LIVE_CHECKOUT_NOT_VERIFIED", "This adapter has not verified the final purchase page. No checkout will be attempted.");
        const { operations, existing } = await this.begin(input.operationId, input, "checkout");
        if (existing) return existing.status === "resolved_by_operator" ? { status: existing.status, resolution: existing.resolution } : existing.result;
        const orders = await this.orders();
        const cart = await this.cart();
        if (cart.revision !== input.expectedRevision) throw new ShoppingError("CART_CHANGED", "The checkout summary changed. Obtain approval again.");
        if (!cart.delivery || !cart.items.length || cart.estimated || !cart.address || !hasCompleteMoney(cart) || cart.items.some(item => item.substitution === null)) throw new ShoppingError("INCOMPLETE_CHECKOUT", "Checkout requires items, a delivery window, and an exact total.");
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
        if (this.recoveryPersistenceUncertain) throw new ShoppingError("STATE_UNREADABLE", "Restart and inspect the preserved ledger after uncertain persistence.");
        const operations = await this.journal.load();
        const operation = operations[operationId];
        if (!operation || operation.kind !== "checkout") throw new ShoppingError("UNKNOWN_OPERATION", "This is not a checkout operation.");
        if (operation.status === "resolved_by_operator") return { status: operation.status, resolution: operation.resolution };
        if (operation.status === "complete" || operation.status === "not_applied") return operation.result;
        const result = await this.verifyOrder(operation);
        operations[operationId] = { ...operation, status: "complete", result };
        await this.journal.save(operations);
        return result;
    }
}
