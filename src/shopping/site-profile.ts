import { z } from "zod";

const selector = z.string().min(1);
const field = z.object({ selector, attribute: z.string().min(1).optional() });
const slot = z.object({ id: field, start: field, end: field });
export const cartFieldsSchema = z.object({
    ready: selector, accountId: field, address: field, deliveryFee: field, total: field,
    currency: field, estimated: field, deliverySelected: selector, delivery: slot,
    items: z.object({
        rows: selector, productId: field, sellingMethod: field, name: field, unit: field,
        quantity: field, unitPrice: field, lineTotal: field, substitution: field,
        quantityInput: selector, updateButton: selector, removeButton: selector,
    }),
});

// Operator-supplied after live inspection; MCP callers cannot inject paths or selectors.
export const siteProfileSchema = z.object({
    authenticated: selector,
    cart: z.object({ path: z.string().min(1), fields: cartFieldsSchema }),
    orders: z.object({
        path: z.string().min(1), ready: selector, rows: selector,
        orderNumber: field, status: field, detailLink: selector, nextPage: selector,
        statusValues: z.object({ pending: selector, confirmed: selector, delivered: selector, cancelled: selector }),
        fields: cartFieldsSchema,
    }),
    slots: z.object({ path: z.string().min(1), ready: selector, rows: selector, fields: slot, selectButton: selector }),
    checkout: z.object({ path: z.string().min(1), fields: cartFieldsSchema, submitButton: selector }),
});
export type SiteProfile = z.infer<typeof siteProfileSchema>;
export type CartFields = z.infer<typeof cartFieldsSchema>;

export function sameOriginUrl(path: string, base: string): string {
    const url = new URL(path, base);
    if (url.origin !== new URL(base).origin || url.username || url.password) throw new Error("Cross-origin site profile URL");
    return url.href;
}
