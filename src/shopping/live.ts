import { createHash } from "node:crypto";
import { type Page } from "puppeteer";
import { z } from "zod";
import { BrowserShoppingSite } from "./site.js";
import { cartSchema, orderSchema, ShoppingError, slotSchema, type ProductKey, type Order } from "./model.js";

const base = "https://www.shufersal.co.il/online/he/";
const accountSchema = z.object({ uid: z.string().min(1), anonymous: z.literal(false) });
const availableSlotsSchema = z.record(z.array(z.object({
    code: z.string().min(1), fromHour: z.number(), toHour: z.number(), selectable: z.boolean(),
    price: z.object({ value: z.number().nonnegative(), currencyIso: z.literal("ILS") }),
})));

/** Live mapping observed 2026-10-20. Checkout stays blocked until its own end-to-end validation. */
export class LiveShufersalSite extends BrowserShoppingSite {
    readonly capabilities = { selectSlot: false, submit: false };
    constructor(private readonly livePage: () => Promise<Page>, private readonly liveAuthenticate?: (page: Page) => Promise<void>, private readonly liveBase = base) {
        super(livePage, undefined, liveBase, liveAuthenticate);
    }

    private async page(path = "A") {
        const page = await this.livePage();
        if (this.liveAuthenticate) await this.liveAuthenticate(page);
        const url = new URL(path, this.liveBase);
        if (url.origin !== new URL(this.liveBase).origin) throw new ShoppingError("INVALID_ORIGIN", "Expected the Shufersal origin.");
        const response = await page.goto(url.href, { waitUntil: "domcontentloaded" });
        if (!response?.ok() || new URL(page.url()).origin !== url.origin) throw new ShoppingError("SITE_UNAVAILABLE", "Shufersal did not return the requested page.");
        await page.waitForFunction(() => Boolean(window.miglog?.account));
        const readAccount = async () => accountSchema.safeParse(await page.evaluate(() => ({ uid: window.miglog?.account?.uid, anonymous: window.miglog?.account?.anonymous })));
        let account = await readAccount();
        if (!account.success && this.liveAuthenticate) {
            await this.liveAuthenticate(page);
            const refreshed = await page.goto(url.href, { waitUntil: "domcontentloaded" });
            if (!refreshed?.ok() || new URL(page.url()).origin !== url.origin) throw new ShoppingError("SITE_UNAVAILABLE", "The page could not be reopened after authentication.");
            await page.waitForFunction(() => Boolean(window.miglog?.account));
            account = await readAccount();
        }
        if (!account.success) throw new ShoppingError("AUTHENTICATION_REQUIRED", "The saved session is no longer authenticated.");
        return { page, accountId: createHash("sha256").update(account.data.uid).digest("hex") };
    }

    override async open() {
        await this.page();
        return { opened: true, authenticated: true, siteAdapter: "live", siteProfileConfigured: false, checkoutVerified: false };
    }

    override async readCart() {
        const { page, accountId } = await this.page();
        await page.waitForSelector("#cartContainer");
        const cart = await page.evaluate(() => {
            const root = document.querySelector("#cartContainer");
            if (!root) throw new Error("Cart missing");
            const number = (value: string | null | undefined) => {
                const match = value?.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/g);
                if (match?.length !== 1) throw new Error("Ambiguous price");
                return Number(match[0]);
            };
            const items = Array.from(root.querySelectorAll("article[data-product-code][data-entry-number]")).map(row => {
                const quantity = number(row.getAttribute("data-entry-qty"));
                const gross = number(row.querySelector(".miglog-prod-totalPrize")?.textContent);
                const discountNode = row.querySelector(".miglog-prod-totalDiscount");
                const discount = discountNode ? number(discountNode.textContent) : 0;
                if (discount > 0) throw new Error("Unexpected discount sign");
                const method = row.querySelector("[name='sellingMethod']");
                const sellingMethod = method instanceof HTMLSelectElement || method instanceof HTMLInputElement ? method.value : null;
                if (sellingMethod !== "BY_UNIT" && sellingMethod !== "BY_WEIGHT") throw new Error("Unknown selling method");
                const commentInput = row.querySelector("input[name^='comment_']");
                return {
                    productId: row.getAttribute("data-product-code"), sellingMethod,
                    name: row.querySelector(".miglog-prod-name")?.textContent?.trim(), quantity,
                    unit: sellingMethod === "BY_WEIGHT" ? "kg" : "unit",
                    unitPrice: Math.round(gross / quantity * 10000) / 10000,
                    lineTotal: Math.round((gross + discount) * 100) / 100,
                    substitution: null,
                    comment: commentInput instanceof HTMLInputElement ? commentInput.value : "",
                };
            });
            const totalNodes = root.querySelectorAll(".totalPrice");
            const deliveryNodes = root.querySelectorAll(".infoSubText");
            if (totalNodes.length !== 1 || deliveryNodes.length !== 1) throw new Error("Cart totals ambiguous");
            return { items, address: null, delivery: null, currency: "ILS", estimated: true,
                deliveryFee: number(deliveryNodes[0].textContent), total: number(totalNodes[0].textContent),
            };
        });
        return cartSchema.parse({ ...cart, accountId });
    }

    override async readSlots() {
        const { page } = await this.page();
        const raw: unknown = await page.evaluate(async () => {
            const response = await fetch("/online/he/timeSlot/preselection/getHomeDeliverySlots?amount=1.0", { credentials: "include", signal: AbortSignal.timeout(15_000) });
            if (!response.ok) throw new Error("Slots unavailable");
            const data = await response.json();
            return Object.fromEntries(Object.entries(data).map(([date, values]) => [date, Array.isArray(values) ? values.map(slot => ({
                code: slot.code, fromHour: slot.fromHour, toHour: slot.toHour, selectable: slot.selectable,
                price: { value: slot.price?.value, currencyIso: slot.price?.currencyIso },
            })) : null]));
        });
        return slotSchema.array().parse(Object.values(availableSlotsSchema.parse(raw)).flat().filter(slot => slot.selectable).map(slot => ({
            id: slot.code, start: new Date(slot.fromHour).toISOString(), end: new Date(slot.toHour).toISOString(),
        })));
    }

    override async readOrders(): Promise<Order[]> {
        const { page, accountId } = await this.page("my-account/personal-area/orders/online-orders");
        const listing: unknown = await page.evaluate(async () => {
            const response = await fetch("/online/he/my-account/orders", { credentials: "include", signal: AbortSignal.timeout(15_000) });
            if (!response.ok) throw new Error("Order listing unavailable");
            const data = await response.json();
            if (!Array.isArray(data.activeOrders) || !Array.isArray(data.closedOrders)) throw new Error("Unknown listing shape");
            return [...data.activeOrders, ...data.closedOrders].map(order => order.code);
        });
        const numbers = z.array(z.string().regex(/^\d+$/)).parse(listing);
        if (new Set(numbers).size !== numbers.length) throw new ShoppingError("INCOMPLETE_HISTORY", "Duplicate order identifiers in the history response.");
        const results: Order[] = [];
        for (const orderNumber of numbers) {
            const raw: unknown = await page.evaluate(async number => {
                const response = await fetch(`/online/he/my-account/orders/${encodeURIComponent(number)}`, { credentials: "include", signal: AbortSignal.timeout(15_000) });
                if (!response.ok) throw new Error("Order unavailable");
                const order = await response.json();
                // Only the allowlisted shopping data crosses the browser boundary; payment and identity data stay out.
                return {
                    code: order.code, status: order.status?.code, total: order.totalPriceWithTax?.value,
                    currency: order.totalPriceWithTax?.currencyIso, address: order.deliveryAddress?.formattedAddress ?? null,
                    substitution: order.deliveryOptions?.replacementPreference ?? null,
                    deliveryFee: order.deliveryCost?.value ?? null,
                    consignments: order.consignments?.map((c: { timeSlotStartTime: number; timeSlotEndTime: number; code: string }) => ({
                        start: c.timeSlotStartTime, end: c.timeSlotEndTime, code: c.code,
                    })),
                    entries: order.entries?.map((entry: { frontQuantity: number; quantity: number; basePrice: { value: number }; totalPrice: { value: number }; customerSellingMethod: { code: string }; product: { code: string; name: string; deliveryItem: boolean; sellingMethod: { code: string } }; entryComment: string | null }) => ({
                        productId: entry.product?.code, name: entry.product?.name, deliveryItem: entry.product?.deliveryItem,
                        quantity: entry.frontQuantity ?? entry.quantity, unitPrice: entry.basePrice?.value, lineTotal: entry.totalPrice?.value,
                        sellingMethod: entry.customerSellingMethod?.code ?? entry.product?.sellingMethod?.code,
                        comment: entry.entryComment ?? "",
                    })),
                };
            }, orderNumber);
            const value = z.object({
                code: z.literal(orderNumber), status: z.string(), total: z.number(), currency: z.literal("ILS"), address: z.string().nullable(),
                substitution: z.string().nullable(), deliveryFee: z.number().nullable(),
                consignments: z.array(z.object({ start: z.number().nullable(), end: z.number().nullable(), code: z.string() })),
                entries: z.array(z.object({ productId: z.string(), name: z.string(), deliveryItem: z.boolean().nullable(),
                    quantity: z.number(), unitPrice: z.number(), lineTotal: z.number(), sellingMethod: z.string().nullable(), comment: z.string() })),
            }).parse(raw);
            const status = value.status === "COMPLETED" || value.status === "DELIVERED" ? "delivered"
                : value.status === "CANCELLED" ? "cancelled" : "pending";
            const consignment = value.consignments.length === 1 ? value.consignments[0] : undefined;
            const delivery = consignment?.start && consignment.end ? { id: consignment.code,
                start: new Date(consignment.start).toISOString(), end: new Date(consignment.end).toISOString() } : null;
            results.push(orderSchema.parse({ orderNumber, status, cart: {
                accountId, address: value.address, currency: value.currency, total: value.total, delivery,
                deliveryFee: value.deliveryFee, estimated: true,
                items: value.entries.filter(entry => !entry.deliveryItem && entry.quantity > 0).map(entry => ({
                    ...entry, unit: entry.sellingMethod === "BY_WEIGHT" ? "kg" : "unit", substitution: value.substitution,
                })),
            } }));
        }
        return results;
    }

    override async add(key: ProductKey, amount: number, comment: string) {
        const { page } = await this.page();
        await page.evaluate(async (key, amount, comment) => {
            if (typeof window.miglog?.cart?.addToCart !== "function") throw new Error("Cart operation unavailable");
            await window.miglog.cart.addToCart(key.productId, amount, key.sellingMethod, comment, { openFrom: "SEARCH", recommendationType: "AUTOCOMPLETE_LIST" });
        }, key, amount, comment);
    }

    override async setQuantity(key: ProductKey, amount: number) {
        const { page } = await this.page();
        await page.evaluate(async (key, amount) => {
            const matches = Array.from(document.querySelectorAll("#cartContainer article[data-product-code][data-entry-number]")).filter(row => {
                const method = row.querySelector("[name='sellingMethod']");
                return row.getAttribute("data-product-code") === key.productId
                    && (method instanceof HTMLInputElement || method instanceof HTMLSelectElement) && method.value === key.sellingMethod;
            });
            if (matches.length !== 1) throw new Error("Ambiguous cart line");
            const entry = Number(matches[0].getAttribute("data-entry-number"));
            await window.miglog.cart.item.update_qty(entry, key.sellingMethod, amount, key.productId);
        }, key, amount);
    }

    override async selectSlot(): Promise<void> {
        throw new ShoppingError("DELIVERY_SELECTION_NOT_VERIFIED", "Reading slots is supported. Selection requires verified address and slot read-back first.");
    }

    override async submit(): Promise<void> {
        throw new ShoppingError("LIVE_CHECKOUT_NOT_VERIFIED", "Live purchase is blocked until the final checkout mapping and approval workflow are verified.");
    }
}
