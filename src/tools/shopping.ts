import { replenishmentInput } from "../shopping/replenishment.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ShoppingError } from "../shopping/model.js";
import { ShoppingService } from "../shopping/service.js";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const guard = { expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), operationId: z.string().uuid() };
const product = { productId: z.string().min(1), sellingMethod: z.string().min(1) };

export function registerShoppingTools(server: McpServer, service: ShoppingService) {
    function tool<T extends z.ZodRawShape>(name: string, description: string, schema: T, mutation: boolean, action: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>) {
        const inputSchema: z.ZodRawShape = schema;
        server.registerTool(name, { description, inputSchema, annotations: mutation ? write : readOnly }, async input => {
            try {
                const result = await service.run(async () => action(z.object(schema).parse(input)));
                return { content: [{ type: "text", text: JSON.stringify({ ok: true, result }) }] };
            } catch (error) {
                const code = error instanceof ShoppingError ? error.code : "SITE_CONTRACT_FAILED";
                const message = error instanceof ShoppingError ? error.message : "Site data or browser operation could not be verified. No raw browser output is exposed.";
                return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code, message } }) }] };
            }
        });
    }
    tool("plan_shufersal_replenishment", "Plan office replenishment without changing the cart. Select 2–8 representative delivered order numbers from history; do not assume listing order is chronological. Map the user stock update to exact product IDs and selling methods. Unlisted stock stays unknown unless the user explicitly says it is empty. Optional target overrides the historical median. Existing cart quantities count toward the target and are never removed.", replenishmentInput, false, async input => service.planReplenishment(input));
    tool("open_shufersal", "Open the dedicated shopping page. The optional configured 1Password provider handles login. No shopping-list prerequisite.", {}, false, async () => service.open());
    tool("search_shufersal", "Search products using the browser session. Returns product IDs, selling methods and prices.", { query: z.string().trim().min(1).max(200) }, false, async ({ query }) => service.search(query));
    tool("get_shufersal_cart", "Read cart lines, prices, total and revision. Unavailable prices, line totals, delivery fee and total are null. Unknown address, delivery and substitution fields are null; incomplete or estimated summaries are not purchase-ready.", {}, false, async () => service.cart());
    tool("get_shufersal_orders", "Read available order history and details. Fails if the listing contract is incomplete.", {}, false, async () => service.orders());
    tool("get_shufersal_order", "Read and verify an order by its number.", { orderNumber: z.string().min(1) }, false, async ({ orderNumber }) => {
        const order = (await service.orders()).find(order => order.orderNumber === orderNumber);
        if (!order) throw new ShoppingError("ORDER_NOT_FOUND", "Order not found in complete history.");
        return order;
    });
    tool("get_shufersal_delivery_slots", "Read available delivery windows with explicit timezone offsets. Scheduling policy belongs to the caller.", {}, false, async () => service.slots());
    tool("add_to_shufersal_cart", "Add a positive quantity and verify the result. Save and reuse operationId on retries. Requires current cart revision.", { ...product, ...guard, quantity: z.number().finite().positive(), comment: z.string().max(500).default("") }, true,
        async input => service.changeQuantity({ ...input, mode: "add" }));
    tool("set_shufersal_cart_quantity", "Set the absolute quantity of an existing product. Zero explicitly removes it. Does not remove any other product.", { ...product, ...guard, quantity: z.number().finite().nonnegative() }, true,
        async input => service.changeQuantity({ ...input, mode: "set", comment: "" }));
    tool("select_shufersal_delivery_slot", "Select and verify an available slot. Read the cart again for the changed delivery fee and revision.", { ...guard, slotId: z.string().min(1) }, true, async input => service.selectSlot(input));
    tool("prepare_shufersal_checkout", "Read a fresh approval summary and possible duplicate orders. Does not submit. Caller owns human approval.", {}, false, async () => service.prepareCheckout());
    tool("submit_shufersal_order", "Purchase only after external approval of expectedRevision. Requires operator-enabled checkout and confirmed=true. Unknown outcomes block further writes.", { ...guard, confirmed: z.literal(true) }, true, async input => service.submit(input));
    tool("reconcile_shufersal_cart", "Read the cart to resolve an uncertain quantity change. Never repeats a mutation; requires all other items to match the saved snapshot.", { operationId: z.string().uuid() }, false, async ({ operationId }) => service.reconcileCart(operationId));
    tool("get_shufersal_operation", "Inspect saved operation outcome. A pending operation must never be blindly retried.", { operationId: z.string().uuid() }, false, async ({ operationId }) => service.operation(operationId));
    tool("reconcile_shufersal_checkout", "Read history to resolve an uncertain checkout. Never submits another order; records the matching order number if proven.", { operationId: z.string().uuid() }, false, async ({ operationId }) => service.reconcileCheckout(operationId));
}
