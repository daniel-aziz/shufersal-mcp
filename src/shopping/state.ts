import { evidenceSchema } from "./evidence.js";
import { recoveryFingerprint, resolutionSchema } from "./recovery.js";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { identitySchema, quantity, revision, cartSchema, lineSchema, slotSchema, ShoppingError } from "./model.js";

const snapshotSchema = cartSchema.extend({
    items: z.array(lineSchema.passthrough()),
    delivery: slotSchema.innerType().passthrough().refine(slot => Date.parse(slot.end) > Date.parse(slot.start), "Invalid delivery window").nullable(),
}).passthrough();

const operationSchema = z.object({
    fingerprint: z.string(),
    kind: z.enum(["cart", "delivery", "checkout"]),
    status: z.enum(["pending", "complete", "resolved_by_operator", "not_applied"]),
    resolution: resolutionSchema.optional(),
    result: z.unknown().optional(),
    evidence: z.array(evidenceSchema).optional(),
    unresolved: z.object({
        reason: z.string(), lastVerifiedQuantity: z.number().finite().nonnegative().nullable(),
        scope: z.object({ accountId: z.string(), cartId: z.string(), equivalenceKeys: z.array(z.string()).min(1) }).nullable(),
    }).optional(),
    checkoutRevision: z.string().optional(),
    previousOrders: z.array(z.string()).optional(),
    cartBefore: snapshotSchema.optional(),
    product: z.object({ productId: z.string(), sellingMethod: z.string() }).passthrough().optional(),
    targetQuantity: z.number().finite().nonnegative().optional(),
    requestedAbsoluteTarget: z.number().finite().nonnegative().optional(),
}).passthrough().superRefine((operation, context) => {
    if (operation.status === "not_applied" && !operation.evidence?.some(item => item.stage === "not_dispatched" && item.outcome === "not_applied"))
        context.addIssue({ code: "custom", message: "Not-applied status requires pre-dispatch evidence" });
    const scope = operation.unresolved?.scope;
    if (scope) {
        const identity = identitySchema.safeParse(operation.product?.identity);
        if (operation.kind !== "cart" || !operation.cartBefore?.integrity?.complete
            || scope.accountId !== operation.cartBefore.accountId || scope.cartId !== operation.cartBefore.integrity.cartId
            || !identity.success || JSON.stringify(scope.equivalenceKeys) !== JSON.stringify(identity.data.equivalenceKeys))
            context.addIssue({ code: "custom", message: "Unresolved scope does not match its verified snapshot and identity" });
    }
    if (operation.status !== "resolved_by_operator") {
        if (operation.resolution) context.addIssue({ code: "custom", message: "Unexpected resolution on non-resolved operation" });
        return;
    }
    const r = operation.resolution;
    const before = operation.cartBefore;
    const product = operation.product;
    if (!r || operation.kind !== "cart" || !before || !product || operation.targetQuantity === undefined) {
        context.addIssue({ code: "custom", message: "Incomplete operator resolution" }); return;
    }
    try {
        if (r.requestFingerprint !== recoveryFingerprint(r.ownerRequest ?? { operationId: r.operationId, resolutionId: r.resolutionId, expectedRevision: r.reviewedRevision, reason: r.reason })
            || r.observedCart.accountId !== before.accountId || r.reviewedRevision !== revision(r.observedCart)
            || r.beforeQuantity !== quantity(before, product) || r.observedQuantity !== quantity(r.observedCart, product)
            || r.targetQuantity !== operation.targetQuantity) throw new Error("Resolution mismatch");
        if (r.approval.channel === "mcp_owner") {
            const request = r.ownerRequest;
            if (!request || request.operationId !== r.operationId || request.resolutionId !== r.resolutionId
                || request.expectedRevision !== r.reviewedRevision || request.reason !== r.reason
                || JSON.stringify({ channel: "mcp_owner", ...request.ownerApproval }) !== JSON.stringify(r.approval)) throw new Error("Owner approval mismatch");
        } else if (r.ownerRequest) throw new Error("Unexpected owner request");
        for (const cart of [before, r.observedCart]) for (const line of cart.items) quantity(cart, line);
    } catch { context.addIssue({ code: "custom", message: "Resolution does not match its evidence" }); }
});
export type Operation = z.infer<typeof operationSchema>;
export interface Journal {
    load(): Promise<Record<string, Operation>>;
    save(operations: Record<string, Operation>): Promise<void>;
}

export class FileJournal implements Journal {
    constructor(private readonly directory: string) {}

    async load(): Promise<Record<string, Operation>> {
        try {
            const operations = z.record(operationSchema).parse(JSON.parse(await readFile(join(this.directory, "operations.json"), "utf8")));
            const resolutions = new Set<string>();
            for (const [id, operation] of Object.entries(operations)) if (operation.resolution) {
                if (operation.resolution.operationId !== id || resolutions.has(operation.resolution.resolutionId)) throw new Error("Conflicting resolution identity");
                resolutions.add(operation.resolution.resolutionId);
            }
            return operations;
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
            throw new ShoppingError("STATE_UNREADABLE", "Operation history is unreadable. Writes are blocked; preserve it for recovery.");
        }
    }

    async save(operations: Record<string, Operation>): Promise<void> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const temporary = join(this.directory, "operations.tmp");
        const file = await open(temporary, "w", 0o600);
        try {
            await file.writeFile(JSON.stringify(operations));
            await file.sync();
        } finally { await file.close(); }
        await rename(temporary, join(this.directory, "operations.json"));
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
    }
}

/** Never steal a stale lock: the previous process may have submitted an order. */
export async function acquireOwnership(directory: string): Promise<() => Promise<void>> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "owner.lock");
    try {
        const file = await open(path, "wx", 0o600);
        try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
    } catch {
        throw new ShoppingError("ACCOUNT_LOCKED", "Another worker owns this state directory, or a stale lock needs manual recovery.");
    }
    return async () => { await rm(path); };
}

export class SerialQueue {
    private tail: Promise<void> = Promise.resolve();

    async run<T>(action: () => Promise<T>): Promise<T> {
        const previous = this.tail;
        let release: () => void = () => {};
        this.tail = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try { return await action(); } finally { release(); }
    }
}
