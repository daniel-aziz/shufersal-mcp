import { z } from "zod";
import { quantity, revision, ShoppingError, type Cart, type Order } from "./model.js";

const key = { productId: z.string().min(1), sellingMethod: z.string().min(1) };
export const replenishmentInput = {
    orderNumbers: z.array(z.string().min(1)).min(2).max(8),
    stock: z.array(z.object({ ...key, remaining: z.number().finite().nonnegative(), target: z.number().finite().nonnegative().optional() })).max(300).default([]),
    unlistedStockIsEmpty: z.boolean().default(false),
};
export const replenishmentSchema = z.object(replenishmentInput);
const productKey = (item: { productId: string; sellingMethod: string }) => JSON.stringify([item.productId, item.sellingMethod]);

export function planReplenishment(cart: Cart, history: Order[], input: z.infer<typeof replenishmentSchema>) {
    const selected = input.orderNumbers.map(number => {
        const matches = history.filter(order => order.orderNumber === number);
        if (matches.length !== 1 || matches[0].status !== "delivered" || matches[0].cart.accountId !== cart.accountId)
            throw new ShoppingError("INVALID_BASELINE", "Select distinct delivered orders from this account for the office baseline.");
        return matches[0];
    });
    if (new Set(input.orderNumbers).size !== selected.length || new Set(input.stock.map(productKey)).size !== input.stock.length)
        throw new ShoppingError("DUPLICATE_INPUT", "Order numbers and stock product keys must be unique.");
    const products = new Map<string, Cart["items"][number]>();
    for (const order of selected) for (const item of order.cart.items) {
        quantity(order.cart, item);
        products.set(productKey(item), item);
    }
    for (const item of cart.items) quantity(cart, item);
    for (const stock of input.stock) if (!products.has(productKey(stock)))
        throw new ShoppingError("UNKNOWN_STOCK_PRODUCT", "Map stock to exact baseline product IDs and selling methods. Handle new products with search and guarded cart tools.");
    const lines = [...products.values()].map(item => {
        const amounts = selected.map(order => quantity(order.cart, item)).sort((a, b) => a - b);
        const occurrences = amounts.filter(amount => amount > 0).length;
        const regular = occurrences >= Math.max(2, Math.ceil(selected.length / 2));
        const midpoint = Math.floor(amounts.length / 2);
        const historicalTarget = amounts.length % 2 ? amounts[midpoint] : (amounts[midpoint - 1] + amounts[midpoint]) / 2;
        const stock = input.stock.find(value => productKey(value) === productKey(item));
        const target = stock?.target ?? (regular ? historicalTarget : 0);
        const remaining = stock?.remaining ?? (input.unlistedStockIsEmpty ? 0 : null);
        const inCart = quantity(cart, item);
        const addQuantity = target === 0 ? 0 : remaining === null ? null : Math.max(0, Number((target - remaining - inCart).toFixed(3)));
        return { productId: item.productId, sellingMethod: item.sellingMethod, name: item.name, unit: item.unit,
            occurrences, sampleSize: selected.length, regular, historicalTarget, target, remaining, inCart, addQuantity,
            needsStockUpdate: target > 0 && remaining === null,
            needsQuantityReview: item.unit !== "kg" && !Number.isInteger(target),
        };
    });
    const activeOrderNumbers = history.filter(order => order.cart.accountId === cart.accountId && ["pending", "confirmed"].includes(order.status)).map(order => order.orderNumber);
    return { cartRevision: revision(cart), baselineOrderNumbers: input.orderNumbers, lines, activeOrderNumbers,
        ready: !activeOrderNumbers.length && lines.every(line => !line.needsStockUpdate && !line.needsQuantityReview),
        preservedCartItems: cart.items, pricesRequireRefresh: true,
        instructions: "No cart changes made. Review active orders first. Resolve missing stock and fractional unit targets. Search current products/prices before adding. Add only positive differences using guarded tools, sequentially with the latest revision. Never remove existing items or automatically substitute unavailable products." };
}
