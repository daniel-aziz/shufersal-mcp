import { createHash } from "node:crypto";
import { z } from "zod";
import { cartSchema, quantity, revision, ShoppingError, type Cart } from "./model.js";
import { type Operation } from "./state.js";

export const recoveryInputSchema = z.object({
    operationId: z.string().uuid(), resolutionId: z.string().uuid(),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(1).max(1000),
}).strict();
export type RecoveryInput = z.infer<typeof recoveryInputSchema>;
export const operatorApprovalSchema = z.object({
    actor: z.string().trim().min(1), channel: z.literal("local_terminal"),
    workersStopped: z.literal(true), requestsInvestigated: z.literal(true), acceptsUnknownOutcome: z.literal(true),
});
export type OperatorApproval = z.infer<typeof operatorApprovalSchema>;
export type RecoveryApprover = (assessment: ReturnType<typeof assessCartRecovery>, input: RecoveryInput) => Promise<OperatorApproval>;
export const targetsSchema = z.array(z.object({
    productId: z.string().trim().min(1), sellingMethod: z.string().trim().min(1),
    quantity: z.number().finite().nonnegative(),
}).strict()).min(1).max(200).refine(targets => new Set(targets.map(t => JSON.stringify([t.productId, t.sellingMethod]))).size === targets.length, "Duplicate targets");
export const ownerRecoverySchema = recoveryInputSchema.extend({
    targets: targetsSchema,
    ownerApproval: z.object({
        confirmed: z.literal(true), owner: z.string().trim().min(1).max(200),
        approvalReference: z.string().trim().min(1).max(1000),
        acceptsUnknownOutcome: z.literal(true), outstandingRequestsInvestigated: z.literal(true),
    }).strict(),
}).strict();
export const mcpApprovalSchema = z.object({
    channel: z.literal("mcp_owner"), ...ownerRecoverySchema.shape.ownerApproval.shape,
});

export function targetComparison(cart: Cart, targets: z.infer<typeof targetsSchema>) {
    return targets.map(target => ({ ...target, currentQuantity: quantity(cart, target),
        missingQuantity: Math.max(0, target.quantity - quantity(cart, target)),
    }));
}

/** One durable attempt per approved product, even across response loss and process restart. */
export function recoveryAdditionId(resolutionId: string, product: { productId: string; sellingMethod: string }) {
    const hex = createHash("sha256").update(JSON.stringify(["recovery-add-v1", resolutionId, product.productId, product.sellingMethod])).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const resolutionSchema = z.object({
    version: z.literal(1), operationId: z.string().uuid(), resolutionId: z.string().uuid(),
    decision: z.literal("accept_current_state"), historicalOutcome: z.literal("unknown"),
    recordedAt: z.string().datetime(), reason: z.string().trim().min(1).max(1000),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    reviewedRevision: z.string().regex(/^[a-f0-9]{64}$/), observedCart: cartSchema,
    beforeQuantity: z.number().finite().nonnegative(), targetQuantity: z.number().finite().nonnegative(),
    observedQuantity: z.number().finite().nonnegative(), approval: z.union([operatorApprovalSchema, mcpApprovalSchema]), ownerRequest: ownerRecoverySchema.optional(),
});

export function recoveryFingerprint(input: RecoveryInput): string {
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function assessCartRecovery(operationId: string, operation: Operation, current: Cart) {
    if (operation.kind !== "cart" || operation.status !== "pending") throw new ShoppingError("NOT_PENDING_CART", "Only a pending cart operation can be assessed for operator recovery.");
    const { cartBefore, product, targetQuantity } = operation;
    if (!cartBefore || !product || targetQuantity === undefined) throw new ShoppingError("RECOVERY_DATA_MISSING", "The original snapshot and product target are required; preserve the ledger.");
    if (cartBefore.accountId !== current.accountId) throw new ShoppingError("ACCOUNT_CHANGED", "The cart belongs to a different account.");
    for (const cart of [cartBefore, current]) for (const line of cart.items) quantity(cart, line);
    const key = (item: { productId: string; sellingMethod: string }) => JSON.stringify([item.productId, item.sellingMethod]);
    const keys = new Map([...cartBefore.items, ...current.items].map(item => [key(item), { productId: item.productId, sellingMethod: item.sellingMethod }]));
    const changedUnrelatedQuantities = [...keys.values()].filter(item => key(item) !== key(product)).flatMap(item => {
        const beforeQuantity = quantity(cartBefore, item); const currentQuantity = quantity(current, item);
        return beforeQuantity === currentQuantity ? [] : [{ ...item, beforeQuantity, currentQuantity }];
    });
    return {
        operationId, product, beforeQuantity: quantity(cartBefore, product), targetQuantity,
        currentQuantity: quantity(current, product), currentRevision: revision(current), changedUnrelatedQuantities,
        addressChanged: cartBefore.address !== current.address,
        deliveryChanged: JSON.stringify(cartBefore.delivery) !== JSON.stringify(current.delivery),
        historicalOutcome: "unknown", automaticReplayAllowed: false,
        warning: "Current quantities cannot prove whether the original write happened. Acceptance retires the old intent without replay; it does not prove success or failure. Stop old workers and investigate outstanding requests. Delayed remote writes and edits by colleagues remain possible.",
    };
}
