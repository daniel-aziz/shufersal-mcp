import { evidenceSchema } from "./evidence.js";
import { recoveryFingerprint, resolutionSchema } from "./recovery.js";
import { mkdir, open, readFile, rename, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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

const ownerSchema = z.object({ version: z.literal(1), pid: z.number().int().positive(), host: z.string().min(1), started: z.string().min(1), token: z.string().uuid() });
function ownerRecord() {
    return { version: 1 as const, pid: process.pid, host: hostname(),
        started: execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" }).trim(), token: randomUUID() };
}
async function exists(path: string) {
    try { await readFile(path); return true; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}
const locked = () => new ShoppingError("ACCOUNT_LOCKED", "State is owned or recovery is in progress. Stop duplicate workers; for a crashed worker run node dist/recover-lock.js using the same configuration. Never delete the lock or ledger.");

/** Acquisitions also check the recovery gate after creating their exclusive lock. */
export async function acquireOwnership(directory: string): Promise<() => Promise<void>> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "owner.lock"), gate = join(directory, "owner-recovery.lock");
    if (await exists(gate)) throw locked();
    const record = JSON.stringify(ownerRecord());
    try {
        const file = await open(path, "wx", 0o600);
        try { await file.writeFile(record); await file.sync(); } finally { await file.close(); }
    } catch { throw locked(); }
    const release = async () => {
        if (await readFile(path, "utf8").catch(() => "") !== record) throw new ShoppingError("OWNERSHIP_CHANGED", "Owner identity changed; preserve state and stop this worker.");
        await rm(path);
    };
    if (await exists(gate)) { await release(); throw locked(); }
    return release;
}

/** Explicit offline recovery; never decides the outcome of an operation. */
export async function inspectOwnership(directory: string) {
    const recoveryInProgress = await exists(join(directory, "owner-recovery.lock"));
    const original = await readFile(join(directory, "owner.lock"), "utf8").catch(error => {
        if (error.code === "ENOENT") return null; throw error;
    });
    if (original === null) {
        const operations = await new FileJournal(directory).load();
        return { status: recoveryInProgress ? "recovery_blocked" : "unlocked", lockFingerprint: null,
            pendingOperationIds: Object.entries(operations).filter(([, op]) => op.status === "pending").map(([id]) => id), recoveryInProgress };
    }
    let value: unknown; try { value = JSON.parse(original); } catch { value = null; }
    const parsed = ownerSchema.safeParse(value);
    const pid = parsed.success ? parsed.data.pid : /^\d+$/.test(original.trim()) ? Number(original.trim()) : null;
    let processState = "unknown";
    if (pid && Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); processState = "alive_or_reused"; }
        catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") processState = "absent"; }
    }
    const operations = await new FileJournal(directory).load();
    return { status: recoveryInProgress ? "recovery_blocked" : "locked", lockFingerprint: createHash("sha256").update(original).digest("hex"), format: parsed.success ? "verified_record" : pid ? "legacy_pid" : "malformed",
        pid, processState, sameHost: parsed.success ? parsed.data.host === hostname() : null,
        pendingOperationIds: Object.entries(operations).filter(([, op]) => op.status === "pending").map(([id]) => id),
        recoveryInProgress: await exists(join(directory, "owner-recovery.lock")) };
}
export async function recoverOwnership(directory: string, approval?: { expectedFingerprint: string; confirmLegacyLocalOwner: boolean }) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const gate = join(directory, "owner-recovery.lock"), path = join(directory, "owner.lock");
    const recoveryId = randomUUID();
    let gateFile;
    try { gateFile = await open(gate, "wx", 0o600); }
    catch { throw new ShoppingError("RECOVERY_LOCKED", "Recovery is already active or interrupted. Preserve the recovery marker for investigation."); }
    try {
        await gateFile.writeFile(JSON.stringify({ recoveryId, ...ownerRecord() })); await gateFile.sync();
        const original = await readFile(path, "utf8").catch(error => {
            if (error.code === "ENOENT") return null; throw error;
        });
        if (original === null) {
            const operations = await new FileJournal(directory).load();
            return { status: "already_unlocked", pendingOperationIds: Object.entries(operations).filter(([, op]) => op.status === "pending").map(([id]) => id) };
        }
        const fingerprint = createHash("sha256").update(original).digest("hex");
        if (approval && approval.expectedFingerprint !== fingerprint) throw new ShoppingError("OWNERSHIP_CHANGED", "Lock differs from reviewed fingerprint. Inspect again.");
        let value: unknown; try { value = JSON.parse(original); } catch { value = null; }
        let parsed = ownerSchema.safeParse(value);
        const legacy = !parsed.success && /^\d+$/.test(original.trim());
        if (legacy && approval?.confirmLegacyLocalOwner) {
            const profileLock = await lstat(join(directory, "browser", "SingletonLock")).then(() => true).catch(error => { if (error.code === "ENOENT") return false; throw error; });
            if (profileLock) throw new ShoppingError("BROWSER_OWNERSHIP_UNVERIFIED", "Browser profile lock exists. Close and verify its owner before legacy recovery; do not delete it blindly.");
            parsed = ownerSchema.safeParse({ version: 1, pid: Number(original.trim()), host: hostname(), started: "legacy-owner-attested", token: randomUUID() });
        }
        if (!parsed.success || parsed.data.host !== hostname()) throw new ShoppingError("OWNER_UNVERIFIED", "Owner identity is legacy, malformed, or belongs to another host. Automatic recovery refused.");
        try { process.kill(parsed.data.pid, 0); throw new ShoppingError("OWNER_ALIVE", "Owner PID is alive or reused. Stop and inspect it; recovery refused."); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
        // Existing state must be readable. Missing ledger is valid only if no operations were recorded.
        const journal = new FileJournal(directory);
        const operations = await journal.load();
        const pendingOperationIds = Object.entries(operations).filter(([, op]) => op.status === "pending").map(([id]) => id);
        if (await readFile(path, "utf8") !== original) throw new ShoppingError("OWNERSHIP_CHANGED", "Ownership changed during recovery; nothing was removed.");
        const audit = { recoveryId, at: new Date().toISOString(), previousOwner: parsed.data, legacyOwnerAttested: legacy, lockFingerprint: fingerprint, pendingOperationIds,
            ledgerDigest: createHash("sha256").update(await readFile(join(directory, "operations.json")).catch(error => {
                if (error.code === "ENOENT") return Buffer.from("absent"); throw error;
            })).digest("hex"), action: "archive_dead_owner_lock_preserve_operations" };
        const auditFile = await open(join(directory, `owner-recovery-${recoveryId}.json`), "wx", 0o600);
        try { await auditFile.writeFile(JSON.stringify(audit)); await auditFile.sync(); } finally { await auditFile.close(); }
        await rename(path, join(directory, `owner-${recoveryId}.lock`));
        const dir = await open(directory, "r"); try { await dir.sync(); } finally { await dir.close(); }
        return audit;
    } catch (error) {
        if (error instanceof ShoppingError) throw error;
        throw new ShoppingError("OWNER_UNVERIFIED", "Could not verify ownership and operation history. No automatic recovery is safe; preserve all state files.");
    } finally { await gateFile.close(); await rm(gate); }
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
