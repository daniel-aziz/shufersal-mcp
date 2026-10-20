import { createHash } from "node:crypto";
import { z } from "zod";
import { ShoppingError } from "./model.js";

export const evidenceSchema = z.object({
    at: z.string().datetime(), stage: z.enum(["prepared", "dispatch_attempted", "not_dispatched", "response_received", "readback_verified", "readback_unverified"]),
    outcome: z.enum(["unknown", "not_applied", "verified"]).optional(),
    errorName: z.enum(["Error", "TypeError", "TimeoutError", "ShoppingError", "Other"]).optional(),
    errorDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    reason: z.enum(["precondition", "transport", "readback_mismatch", "incomplete_read", "response", "adapter_unavailable"]).optional(),
    httpStatus: z.number().int().min(0).max(599).optional(),
    responseQuantity: z.number().finite().nonnegative().nullable().optional(),
    observedQuantity: z.number().finite().nonnegative().nullable().optional(),
    endpoint: z.enum(["cart/add", "cart/update"]).optional(),
});
export type WriteEvidence = z.infer<typeof evidenceSchema>;
export class CartWriteError extends ShoppingError {
    constructor(code: string, message: string, public readonly evidence: WriteEvidence) { super(code, message); }
}
/** Arbitrary exception text may contain credentials. Preserve a digest and allowlisted classification, never raw text/stack/headers. */
export function sanitizedError(error: unknown, stage: WriteEvidence["stage"], reason: WriteEvidence["reason"]): WriteEvidence {
    const name = error instanceof Error ? error.name : "Other";
    return evidenceSchema.parse({ at: new Date().toISOString(), stage, reason,
        errorName: ["Error", "TypeError", "TimeoutError", "ShoppingError"].includes(name) ? name : "Other",
        errorDigest: createHash("sha256").update(error instanceof Error ? `${error.name}:${error.message}` : "Non-Error exception").digest("hex"),
    });
}
