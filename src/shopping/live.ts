import { CartWriteError, sanitizedError, type WriteEvidence } from "./evidence.js";
import { createHash } from "node:crypto";
import { type Page, type HTTPResponse } from "puppeteer";
import { z } from "zod";
import { BrowserShoppingSite } from "./site.js";
import { cartSchema, orderSchema, ShoppingError, slotSchema, type ProductKey, type Order, type ProductDescription } from "./model.js";

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
        await page.waitForFunction(() => Boolean(document.querySelector("#cartContainer article:not(.miglog-prod-comment)"))
            || [...document.querySelectorAll("#cartContainer #cartTotalItems")].some(node => node.textContent?.trim() === "0"));
        const cart = await page.evaluate(() => {
            const roots = document.querySelectorAll("#cartContainer");
            if (roots.length !== 1) throw new Error("Cart missing or ambiguous");
            const root = roots[0];
            const money = (scope: ParentNode, selector: string, signed = false): number | null => {
                const nodes = scope.querySelectorAll(selector);
                if (nodes.length !== 1) return null;
                const matches = nodes[0].textContent?.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/g);
                if (matches?.length !== 1) return null;
                const value = Number(matches[0]);
                return Number.isFinite(value) && (signed || value >= 0) ? value : null;
            };
            // Read every row, including malformed ones: silently skipping a row would make recovery unsafe.
            const rows = Array.from(root.querySelectorAll("article")).filter(row =>
                !row.classList.contains("miglog-prod-comment") || row.matches("[data-product-code], [data-entry-number], [data-entry-qty]")
                || Boolean(row.querySelector(".miglog-prod-name, [name='sellingMethod']")));
            const counts = root.querySelectorAll("#cartTotalItems");
            if (!rows.length && (counts.length !== 1 || counts[0].textContent?.trim() !== "0"))
                throw new Error("Cart contents not verified: missing explicit empty state");
            const entries = new Set<string>();
            const products = new Set<string>();
            const items = rows.map(row => {
                const rawQuantity = row.getAttribute("data-entry-qty");
                const entry = row.getAttribute("data-entry-number");
                const productId = row.getAttribute("data-product-code")?.trim();
                if (!rawQuantity || !/^\d+(?:\.\d+)?$/.test(rawQuantity) || !entry || !/^\d+$/.test(entry)
                    || !productId || entries.has(entry)) throw new Error("Incomplete or duplicate cart row");
                entries.add(entry);
                const quantity = Number(rawQuantity);
                if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Invalid quantity");
                const methods = row.querySelectorAll("[name='sellingMethod']");
                const method = methods.length === 1 ? methods[0] : null;
                const sellingMethod = method instanceof HTMLSelectElement || method instanceof HTMLInputElement ? method.value : null;
                if (sellingMethod !== "BY_UNIT" && sellingMethod !== "BY_WEIGHT") throw new Error("Unknown selling method");
                const key = JSON.stringify([productId, sellingMethod]);
                if (products.has(key)) throw new Error("Duplicate product rows");
                products.add(key);
                const names = row.querySelectorAll(".miglog-prod-name");
                if (names.length !== 1) throw new Error("Missing or ambiguous product name");
                const gross = money(row, ".miglog-prod-totalPrize");
                const discountNodes = row.querySelectorAll(".miglog-prod-totalDiscount");
                const discount = discountNodes.length ? money(row, ".miglog-prod-totalDiscount", true) : 0;
                const net = gross !== null && discount !== null && discount <= 0 ? gross + discount : null;
                const commentInput = row.querySelector("input[name^='comment_']");
                return {
                    productId, sellingMethod, name: names[0].textContent?.trim(), quantity,
                    unit: sellingMethod === "BY_WEIGHT" ? "kg" : "unit",
                    unitPrice: gross === null ? null : Math.round(gross / quantity * 10000) / 10000,
                    lineTotal: net !== null && net >= 0 ? Math.round(net * 100) / 100 : null,
                    substitution: null,
                    identity: { barcode: /^P_\d+$/.test(productId) ? productId.slice(2) : null,
                        variant: row.getAttribute("data-variant"), packSize: row.getAttribute("data-unit-description"),
                        equivalenceKeys: row.getAttribute("data-base-product-code") ? [`sku:${productId.replace(/^P_/, "")}`, `base:${row.getAttribute("data-base-product-code")}`] : null },
                    comment: commentInput instanceof HTMLInputElement ? commentInput.value : "",
                };
            });
            return { items, address: null, delivery: null, currency: "ILS", estimated: true,
                deliveryFee: money(root, ".infoSubText"), total: money(root, ".totalPrice"),
            };
        });
        // The full cart/load response provides an independent membership check. A partial DOM must never imply zero.
        const complete = await page.evaluate(async expected => {
            if (window.miglog.cart?.order) return false;
            const response = await fetch("/online/he/cart/load", { credentials: "include", signal: AbortSignal.timeout(15_000) });
            if (!response.ok) return false;
            const document = new DOMParser().parseFromString(await response.text(), "text/html");
            if (document.querySelectorAll(".miglog-prodlist").length !== 1) return false;
            const rows = [...document.querySelectorAll("article")].filter(row => !row.classList.contains("miglog-prod-comment") || row.hasAttribute("data-product-code"));
            const actual = rows.map(row => {
                const method = row.querySelector("[name='sellingMethod']");
                return { productId: row.getAttribute("data-product-code"), quantity: Number(row.getAttribute("data-entry-qty")),
                    sellingMethod: method instanceof HTMLInputElement || method instanceof HTMLSelectElement ? method.value : null };
            });
            const normalize = (values: unknown[]) => JSON.stringify(values.map(value => JSON.stringify(value)).sort());
            const counts = document.querySelectorAll("#cartTotalItems");
            const explicitlyEmpty = counts.length === 1 && counts[0].textContent?.trim() === "0";
            return (rows.length > 0 || explicitlyEmpty) && normalize(actual) === normalize(expected);
        }, cart.items.map(({ productId, quantity, sellingMethod }) => ({ productId, quantity, sellingMethod })));
        return cartSchema.parse({ ...cart, accountId, integrity: { complete, cartId: "active" } });
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

    override async search(query: string) {
        const result = await super.search(query);
        const barcode = /^(?:P_)?(\d{8,14})$/.exec(query.trim())?.[1];
        if (!barcode) return result;
        const exactLookup = [];
        for (const sellingMethod of ["BY_UNIT", "BY_WEIGHT"] as const) {
            try { exactLookup.push(await this.describeProduct({ productId: `P_${barcode}`, sellingMethod })); }
            catch (error) {
                if (!(error instanceof ShoppingError) || error.code !== "IDENTITY_UNVERIFIED") throw error;
            }
        }
        return { ...result, exactLookup, exactLookupVerified: exactLookup.length > 0 };
    }

    async describeProduct(key: ProductKey, expectedAccountId?: string): Promise<ProductDescription> {
        // Search suggestions can omit a SKU entirely and their price is not stock evidence.
        // The authenticated exact product page exposes explicit Product/Offer availability.
        const { page, accountId } = await this.page(`p/${encodeURIComponent(key.productId)}`);
        if (expectedAccountId && accountId !== expectedAccountId) throw new ShoppingError("ACCOUNT_CHANGED", "Product availability belongs to a different account.");
        const raw = await page.evaluate(key => {
            const roots = [...document.querySelectorAll(".addToCart[data-product-code]")].filter(root => root.getAttribute("data-product-code") === key.productId);
            const products: { sku?: unknown; name?: unknown; offers?: { availability?: unknown } }[] = [];
            for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
                try {
                    const value = JSON.parse(script.textContent ?? "");
                    if (value?.["@type"] === "Product") products.push(value);
                } catch { /* Malformed structured data cannot establish availability. */ }
            }
            const matches = products.filter(product => product.sku === key.productId.replace(/^P_/, ""));
            const root = roots.length === 1 ? roots[0] : null;
            const methods = root?.querySelectorAll('[name="sellingMethod"]');
            const method = methods?.length === 1 ? methods[0] : null;
            const saleUnitMatches = method instanceof HTMLSelectElement
                ? [...method.options].some(option => option.value === key.sellingMethod && !option.disabled)
                : method instanceof HTMLInputElement && method.value === key.sellingMethod;
            if (!root || matches.length !== 1 || !saleUnitMatches) return null;
            const product = matches[0];
            const productScope = root.closest('[itemscope][itemtype="https://schema.org/Product"]');
            const statuses = [...(productScope?.querySelectorAll('[itemscope][itemtype="https://schema.org/Offer"] [itemprop="availability"]') ?? [])].map(node => node.getAttribute("href") ?? node.getAttribute("content"));
            const status = product.offers?.availability;
            // Require the two server-rendered explicit representations to agree. Unknown is never in stock.
            const verified = statuses.length === 1 && statuses[0] === status;
            const available = verified && status === "https://schema.org/InStock" ? true
                : verified && status === "https://schema.org/OutOfStock" ? false : null;
            const packRows = [...(productScope?.querySelectorAll(".dataList .box") ?? [])].filter(box => box.querySelector(".name")?.textContent?.trim() === "מידה/סוג:");
            const baseProduct = root.getAttribute("data-base-product-code")?.trim() || null;
            const variant = root.getAttribute("data-variant")?.trim() || null;
            const packSize = root.getAttribute("data-unit-description")?.trim()
                || (packRows.length === 1 ? packRows[0].querySelector(".text")?.textContent?.trim() ?? null : null);
            return { name: product.name, available, packSize, baseProduct, variant,
                availabilityEvidence: { jsonStatus: typeof status === "string" ? status : null,
                    microdataStatuses: statuses.filter((value): value is string => typeof value === "string"),
                    conflicting: new Set([status, ...statuses].filter(value => typeof value === "string")).size > 1 } };
        }, key);
        const account = accountSchema.safeParse(await page.evaluate(() => ({ uid: window.miglog?.account?.uid, anonymous: window.miglog?.account?.anonymous })));
        if (!account.success || createHash("sha256").update(account.data.uid).digest("hex") !== accountId)
            throw new ShoppingError("ACCOUNT_CHANGED", "Account changed while checking product availability.");
        if (!raw) throw new ShoppingError("IDENTITY_UNVERIFIED", "Exact SKU and sale unit were not uniquely verified on the product page.");
        const product = z.object({ name: z.string().min(1), available: z.boolean().nullable(), packSize: z.string().nullable(),
            variant: z.string().nullable(), baseProduct: z.string().nullable(),
            availabilityEvidence: z.object({ jsonStatus: z.string().nullable(), microdataStatuses: z.array(z.string()), conflicting: z.boolean() }),
        }).parse(raw);
        return { ...key, name: product.name, available: product.available, availabilityEvidence: product.availabilityEvidence,
            identity: { barcode: /^P_\d+$/.test(key.productId) ? key.productId.slice(2) : null,
                variant: product.variant, packSize: product.packSize,
                equivalenceKeys: product.baseProduct ? [`sku:${key.productId.replace(/^P_/, "")}`, `base:${product.baseProduct}`] : null } };
    }

    override async add(key: ProductKey, amount: number, comment: string, guard?: { expectedQuantity: number; targetQuantity: number; accountId: string }): Promise<WriteEvidence> {
        let page: Page;
        try {
            const snapshot = await this.readCart();
            if (!snapshot.integrity?.complete) throw new ShoppingError("INCOMPLETE_CART", "Full cart membership could not be verified.");
            if (!guard || snapshot.accountId !== guard.accountId) throw new ShoppingError("ACCOUNT_CHANGED", "Account changed before dispatch.");
            page = await this.livePage();
        }
        catch (error) { throw new CartWriteError("NOT_DISPATCHED", "The cart page could not be verified before dispatch.", { ...sanitizedError(error, "not_dispatched", "precondition"), outcome: "not_applied" }); }
        let responseStatus: number | undefined;
        const observeResponse = (response: HTTPResponse) => {
            const url = new URL(response.url());
            if (url.origin === new URL(this.liveBase).origin && ["/online/he/cart/add", "/online/he/cart/update"].includes(url.pathname)) responseStatus = response.status();
        };
        page.on("response", observeResponse);
        try {
            const evidence = await page.evaluate(async (key, amount, comment, guard) => {
                const at = () => new Date().toISOString();
                const rows = [...document.querySelectorAll("#cartContainer article[data-product-code]")].filter(row => row.getAttribute("data-product-code") === key.productId);
                const row = rows[0];
                const method = row?.querySelector("[name='sellingMethod']");
                const sellingMethod = method instanceof HTMLInputElement || method instanceof HTMLSelectElement ? method.value : null;
                const current = row ? Number(row.getAttribute("data-entry-qty")) : 0;
                const entry = row?.getAttribute("data-entry-number");
                const target = current + amount;
                if (!guard || rows.length > 1 || (row && (sellingMethod !== key.sellingMethod || !entry || !/^\d+$/.test(entry)))
                    || !Number.isFinite(current) || current !== guard.expectedQuantity || target !== guard.targetQuantity)
                    return { at: at(), stage: "not_dispatched", outcome: "not_applied", reason: "precondition" };
                if (typeof window.miglog?.cart?.addToCart !== "function" || (row && typeof window.miglog.cart.item.update_qty !== "function"))
                    return { at: at(), stage: "not_dispatched", outcome: "not_applied", reason: "adapter_unavailable" };
                const endpoint = row ? "cart/update" : "cart/add";
                try {
                    const response: unknown = row
                        ? await window.miglog.cart.item.update_qty(Number(entry), key.sellingMethod, target, key.productId)
                        : await window.miglog.cart.addToCart(key.productId, amount, key.sellingMethod, comment, null, { openFrom: "SEARCH", recommendationType: "AUTOCOMPLETE_LIST" });
                    let responseQuantity: number | null = null;
                    if (typeof response === "string") {
                        const doc = new DOMParser().parseFromString(response, "text/html");
                        const lines = [...doc.querySelectorAll("article[data-product-code]")].filter(line => line.getAttribute("data-product-code") === key.productId);
                        const raw = lines.length === 1 ? lines[0].getAttribute("data-entry-qty") : null;
                        const value = raw && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
                        if (Number.isFinite(value) && value >= 0) responseQuantity = value;
                    }
                    return { at: at(), stage: "response_received", endpoint, responseQuantity, reason: "response" };
                } catch (error) {
                    // jQuery rejects with an XHR object; only the numeric status may cross the browser boundary.
                    const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 0;
                    const name = error instanceof Error ? error.name : "Other";
                    const original = error instanceof Error ? `${error.name}:${error.message}` : `XHR status ${status}`;
                    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(original));
                    const errorDigest = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
                    return { at: at(), stage: "dispatch_attempted", endpoint, httpStatus: status >= 0 && status <= 599 ? status : 0, reason: "transport",
                        errorName: ["Error", "TypeError", "TimeoutError"].includes(name) ? name : "Other", errorDigest };
                }
            }, key, amount, comment, guard);
            const { evidenceSchema } = await import("./evidence.js");
            const parsed = evidenceSchema.parse({ ...evidence, ...(responseStatus !== undefined ? { httpStatus: responseStatus } : {}) });
            if (parsed.stage === "not_dispatched") throw new CartWriteError("CART_CHANGED", "Adapter preconditions failed before dispatch.", parsed);
            if (parsed.stage === "dispatch_attempted") throw new CartWriteError("OUTCOME_UNKNOWN", "Cart request outcome is unknown.", parsed);
            return parsed;
        } catch (error) {
            if (error instanceof CartWriteError) throw error;
            throw new CartWriteError("OUTCOME_UNKNOWN", "The browser outcome could not be verified.", sanitizedError(error, "dispatch_attempted", "transport"));
        } finally { page.off("response", observeResponse); }
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
