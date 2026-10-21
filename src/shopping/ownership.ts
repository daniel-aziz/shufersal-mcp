import { acquireOwnership } from "./state.js";
import { ShoppingError } from "./model.js";

/** Used inside ShoppingService's queue: ownership spans the entire business operation. */
export class OperationOwnership {
    private cleanupFailed = false;
    constructor(private readonly directory: string, private readonly closeBrowser: () => Promise<void>) {}

    async run<T>(action: () => Promise<T>): Promise<T> {
        if (this.cleanupFailed) throw new ShoppingError("BROWSER_CLEANUP_FAILED", "Browser shutdown was not verified. Preserve ownership and inspect the worker before reconnecting.");
        const release = await acquireOwnership(this.directory);
        try { return await action(); }
        finally { await this.cleanup(release); }
    }

    private async cleanup(release: () => Promise<void>): Promise<void> {
        // Never unlock before browser activity ends, including when an action throws.
        // Pending operations remain in the journal and keep their existing replay guards.
        try { await this.closeBrowser(); }
        catch {
            this.cleanupFailed = true;
            throw new ShoppingError("BROWSER_CLEANUP_FAILED", "Browser shutdown was not verified. Ownership is retained; inspect the worker and operation history. Do not replay a write.");
        }
        await release();
    }
}
