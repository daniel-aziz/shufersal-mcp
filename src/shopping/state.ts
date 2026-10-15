import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ShoppingError } from "./model.js";

const operationSchema = z.object({
    fingerprint: z.string(),
    kind: z.enum(["cart", "delivery", "checkout"]),
    status: z.enum(["pending", "complete"]),
    result: z.unknown().optional(),
    checkoutRevision: z.string().optional(),
    previousOrders: z.array(z.string()).optional(),
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
            return z.record(operationSchema).parse(JSON.parse(await readFile(join(this.directory, "operations.json"), "utf8")));
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
