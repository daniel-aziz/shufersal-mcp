import { createHash } from "node:crypto";
import { z } from "zod";

const money = z.number().finite().nonnegative();
const id = z.string().trim().min(1);
export const lineSchema = z.object({
    productId: id,
    sellingMethod: id,
    name: id,
    unit: id,
    quantity: z.number().finite().positive(),
    unitPrice: money,
    lineTotal: money,
    substitution: id,
});
export const slotSchema = z.object({
    id,
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
}).refine(slot => Date.parse(slot.end) > Date.parse(slot.start), "Invalid delivery window");
export const cartSchema = z.object({
    accountId: id,
    items: z.array(lineSchema),
    address: id,
    delivery: slotSchema.nullable(),
    deliveryFee: money,
    total: money,
    currency: z.literal("ILS"),
    estimated: z.boolean(),
});
export const orderSchema = z.object({
    orderNumber: id,
    status: z.enum(["pending", "confirmed", "delivered", "cancelled"]),
    cart: cartSchema,
});
export type Cart = z.infer<typeof cartSchema>;
export type Order = z.infer<typeof orderSchema>;
export type Slot = z.infer<typeof slotSchema>;
export type ProductKey = Pick<Cart["items"][number], "productId" | "sellingMethod">;

export class ShoppingError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
}

export function revision(cart: Cart): string {
    const items = [...cart.items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return createHash("sha256").update(JSON.stringify({ ...cart, items })).digest("hex");
}

export function sameProduct(line: ProductKey, key: ProductKey): boolean {
    return line.productId === key.productId && line.sellingMethod === key.sellingMethod;
}

export function quantity(cart: Cart, key: ProductKey): number {
    const lines = cart.items.filter(line => sameProduct(line, key));
    if (lines.length > 1) throw new ShoppingError("DUPLICATE_LINES", "Resolve duplicate product lines before changing quantity.");
    return lines[0]?.quantity ?? 0;
}

export function possibleDuplicates(cart: Cart, orders: Order[]): string[] {
    return orders.filter(order =>
        (order.status === "pending" || order.status === "confirmed") &&
        order.cart.accountId === cart.accountId &&
        order.cart.address === cart.address &&
        (cart.delivery === null || order.cart.delivery === null ||
            new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date(order.cart.delivery.start)) ===
            new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date(cart.delivery.start)))
    ).map(order => order.orderNumber);
}

export interface ShoppingSite {
    open(): Promise<unknown>;
    search(query: string): Promise<unknown>;
    readCart(): Promise<Cart>;
    readOrders(): Promise<Order[]>;
    readSlots(): Promise<Slot[]>;
    add(key: ProductKey, amount: number, comment: string): Promise<void>;
    setQuantity(key: ProductKey, amount: number): Promise<void>;
    selectSlot(slotId: string): Promise<void>;
    submit(expectedRevision: string): Promise<void>;
}
