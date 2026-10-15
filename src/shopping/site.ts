import { type Page } from "puppeteer";
import { z } from "zod";
import { cartSchema, orderSchema, revision, ShoppingError, slotSchema, type Cart, type Order, type ProductKey, type ShoppingSite } from "./model.js";
import { type CartFields, type SiteProfile, sameOriginUrl } from "./site-profile.js";

const searchSchema = z.object({ results: z.array(z.object({
    code: z.string(), name: z.string(),
    price: z.union([z.number(), z.object({ value: z.number(), formattedValue: z.string().optional() })]),
    sellingMethod: z.union([z.string(), z.object({ code: z.string() })]),
    unitDescription: z.string().optional(), brandName: z.string().optional(),
})) });

export class BrowserShoppingSite implements ShoppingSite {
    constructor(private readonly getPage: () => Promise<Page>, private readonly profile: SiteProfile | undefined,
        private readonly base = "https://www.shufersal.co.il/online/he/") {}

    private requireProfile(): SiteProfile {
        if (!this.profile) throw new ShoppingError("SITE_PROFILE_REQUIRED", "This tool requires a live-verified site profile. No unverified selectors or checkout endpoints are assumed.");
        return this.profile;
    }

    private async navigate(path: string): Promise<Page> {
        const page = await this.getPage();
        const response = await page.goto(sameOriginUrl(path, this.base), { waitUntil: "domcontentloaded" });
        if (!response?.ok()) throw new ShoppingError("SITE_UNAVAILABLE", "The site did not return a successful page. Check access and authentication.");
        sameOriginUrl(page.url(), this.base);
        return page;
    }

    private async authenticatedPage(path: string): Promise<Page> {
        const profile = this.requireProfile();
        const page = await this.navigate(path);
        try { await page.waitForSelector(profile.authenticated, { timeout: 5000 }); }
        catch { throw new ShoppingError("AUTHENTICATION_REQUIRED", "Sign in through the browser or external authentication integration. Never pass credentials as tool arguments."); }
        return page;
    }

    async open() {
        const page = await this.navigate(this.base);
        return { opened: true, authenticated: this.profile ? Boolean(await page.$(this.profile.authenticated)) : null,
            siteProfileConfigured: Boolean(this.profile) };
    }

    async search(query: string) {
        const page = await this.navigate(this.base);
        const result: unknown = await page.evaluate(async (base, query) => {
            const url = new URL("search/results", base);
            url.searchParams.set("q", query);
            url.searchParams.set("limit", "30");
            const response = await fetch(url, { credentials: "include", headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" }, signal: AbortSignal.timeout(15_000) });
            if (!response.ok) throw new Error("Search failed");
            return response.json();
        }, this.base, query);
        return searchSchema.parse(result);
    }

    private async extractCart(page: Page, fields: CartFields): Promise<Cart> {
        await page.waitForSelector(fields.ready);
        const raw = await page.evaluate(fields => {
            const read = (root: ParentNode, field: { selector: string; attribute?: string }): string => {
                const nodes = root.querySelectorAll(field.selector);
                if (nodes.length !== 1) throw new Error("Expected one field");
                const element = nodes[0];
                const value = field.attribute ? element.getAttribute(field.attribute) : element instanceof HTMLInputElement ? element.value : element.textContent;
                if (value === null) throw new Error("Missing field value");
                return value.trim();
            };
            const number = (text: string) => {
                const value = text.replace(/[₪\s,]/g, "");
                if (!/^(?:\d+)(?:\.\d+)?$/.test(value)) throw new Error("Invalid number");
                return Number(value);
            };
            const estimated = read(document, fields.estimated);
            if (estimated !== "true" && estimated !== "false") throw new Error("Unknown total certainty");
            return {
                accountId: read(document, fields.accountId), address: read(document, fields.address),
                currency: read(document, fields.currency), estimated: estimated === "true",
                deliveryFee: number(read(document, fields.deliveryFee)), total: number(read(document, fields.total)),
                delivery: document.querySelector(fields.deliverySelected) ? {
                    id: read(document, fields.delivery.id), start: read(document, fields.delivery.start), end: read(document, fields.delivery.end),
                } : null,
                items: [...document.querySelectorAll(fields.items.rows)].map(row => ({
                    productId: read(row, fields.items.productId), sellingMethod: read(row, fields.items.sellingMethod),
                    name: read(row, fields.items.name), unit: read(row, fields.items.unit),
                    quantity: number(read(row, fields.items.quantity)), unitPrice: number(read(row, fields.items.unitPrice)),
                    lineTotal: number(read(row, fields.items.lineTotal)), substitution: read(row, fields.items.substitution),
                })),
            };
        }, fields);
        return cartSchema.parse(raw);
    }

    async readCart() {
        const { cart } = this.requireProfile();
        return this.extractCart(await this.authenticatedPage(cart.path), cart.fields);
    }

    async readOrders(): Promise<Order[]> {
        const { orders } = this.requireProfile();
        const result: Order[] = [];
        const visited = new Set<string>();
        let path: string | null = orders.path;
        while (path) {
            const url = sameOriginUrl(path, this.base);
            if (visited.has(url) || visited.size >= 50) throw new ShoppingError("INCOMPLETE_HISTORY", "Order history pagination did not complete. Checkout is blocked.");
            visited.add(url);
            const page = await this.authenticatedPage(url);
            await page.waitForSelector(orders.ready);
            const listing: { entries: { orderNumber: string; status: string; href: string }[]; next: string | null } = await page.evaluate(mapping => {
                const read = (root: ParentNode, field: { selector: string; attribute?: string }) => {
                    const nodes = root.querySelectorAll(field.selector);
                    if (nodes.length !== 1) throw new Error("Ambiguous order field");
                    const value = field.attribute ? nodes[0].getAttribute(field.attribute) : nodes[0].textContent;
                    if (!value) throw new Error("Missing order field");
                    return value.trim();
                };
                return {
                    entries: [...document.querySelectorAll(mapping.rows)].map(row => ({
                        orderNumber: read(row, mapping.orderNumber), status: read(row, mapping.status),
                        href: read(row, { selector: mapping.detailLink, attribute: "href" }),
                    })),
                    next: document.querySelector(mapping.nextPage)?.getAttribute("href") ?? null,
                };
            }, orders);
            for (const entry of listing.entries) {
                const detail = await this.authenticatedPage(entry.href);
                const status = Object.entries(orders.statusValues).find(([, value]) => value === entry.status)?.[0];
                result.push(orderSchema.parse({ orderNumber: entry.orderNumber, status, cart: await this.extractCart(detail, orders.fields) }));
            }
            path = listing.next;
        }
        if (new Set(result.map(order => order.orderNumber)).size !== result.length) throw new ShoppingError("INCOMPLETE_HISTORY", "Duplicate order IDs appeared while reading history. Try a fresh read.");
        return result;
    }

    async readSlots() {
        const { slots } = this.requireProfile();
        const page = await this.authenticatedPage(slots.path);
        await page.waitForSelector(slots.ready);
        const values = await page.evaluate(mapping => [...document.querySelectorAll(mapping.rows)].map(row => {
            const read = (field: { selector: string; attribute?: string }) => {
                const nodes = row.querySelectorAll(field.selector);
                if (nodes.length !== 1) throw new Error("Missing slot field");
                return (field.attribute ? nodes[0].getAttribute(field.attribute) : nodes[0].textContent)?.trim();
            };
            return { id: read(mapping.fields.id), start: read(mapping.fields.start), end: read(mapping.fields.end) };
        }), slots);
        return slotSchema.array().parse(values);
    }

    async add(key: ProductKey, amount: number, comment: string) {
        await this.readCart();
        const page = await this.getPage();
        await page.evaluate(async (key, amount, comment) => {
            if (typeof window.ajaxCall !== "function") throw new Error("Cart API unavailable");
            await window.ajaxCall("/cart/add", JSON.stringify({ productCodePost: key.productId, productCode: key.productId,
                sellingMethod: key.sellingMethod, qty: amount, frontQuantity: amount, comment, affiliateCode: "" }),
            () => {}, null, { openFrom: "SEARCH", recommendationType: "AUTOCOMPLETE_LIST" });
        }, key, amount, comment);
    }

    async setQuantity(key: ProductKey, amount: number) {
        const { cart } = this.requireProfile();
        const page = await this.authenticatedPage(cart.path);
        await page.waitForSelector(cart.fields.ready);
        const row = await this.findRow(page, cart.fields.items.rows, cart.fields.items.productId, key.productId, cart.fields.items.sellingMethod, key.sellingMethod);
        try {
            if (amount === 0) {
                await row.$eval(cart.fields.items.removeButton, button => { if (!(button instanceof HTMLElement)) throw new Error("Missing button"); button.click(); });
            } else {
                await row.$eval(cart.fields.items.quantityInput, (input, value) => {
                    if (!(input instanceof HTMLInputElement)) throw new Error("Missing quantity input");
                    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
                    if (!setter) throw new Error("Missing input setter");
                    setter.call(input, String(value));
                    input.dispatchEvent(new Event("input", { bubbles: true }));
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                }, amount);
                await row.$eval(cart.fields.items.updateButton, button => { if (!(button instanceof HTMLElement)) throw new Error("Missing button"); button.click(); });
            }
        } finally { await row.dispose(); }
        await page.waitForNetworkIdle({ idleTime: 250, timeout: 10_000 });
    }

    private async findRow(page: Page, selector: string, field: { selector: string; attribute?: string }, value: string, second?: { selector: string; attribute?: string }, secondValue?: string) {
        const rows = await page.$$(selector);
        const matches = [];
        for (const row of rows) {
            const matched = await row.evaluate((element, field, value, second, secondValue) => {
                const read = (mapping: { selector: string; attribute?: string }) => {
                    const node = element.querySelector(mapping.selector);
                    return (mapping.attribute ? node?.getAttribute(mapping.attribute) : node?.textContent)?.trim();
                };
                return read(field) === value && (!second || read(second) === secondValue);
            }, field, value, second, secondValue);
            if (matched) matches.push(row); else await row.dispose();
        }
        if (matches.length !== 1) {
            await Promise.all(matches.map(row => row.dispose()));
            throw new ShoppingError("AMBIGUOUS_TARGET", "Expected exactly one matching product or slot.");
        }
        return matches[0];
    }

    async selectSlot(slotId: string) {
        const { slots } = this.requireProfile();
        const page = await this.authenticatedPage(slots.path);
        await page.waitForSelector(slots.ready);
        const row = await this.findRow(page, slots.rows, slots.fields.id, slotId);
        try { await row.$eval(slots.selectButton, button => { if (!(button instanceof HTMLElement)) throw new Error("Missing button"); button.click(); }); }
        finally { await row.dispose(); }
        await page.waitForNetworkIdle({ idleTime: 250, timeout: 10_000 });
    }

    async submit(expectedRevision: string) {
        const { checkout } = this.requireProfile();
        const page = await this.authenticatedPage(checkout.path);
        const summary = await this.extractCart(page, checkout.fields);
        if (revision(summary) !== expectedRevision) throw new ShoppingError("CART_CHANGED", "Final checkout differs from the approved cart.");
        const buttons = await page.$$(checkout.submitButton);
        if (buttons.length !== 1) throw new ShoppingError("AMBIGUOUS_TARGET", "Expected one final submit button.");
        try { await buttons[0].click(); } finally { await buttons[0].dispose(); }
        await page.waitForNetworkIdle({ idleTime: 250, timeout: 10_000 });
    }
}
