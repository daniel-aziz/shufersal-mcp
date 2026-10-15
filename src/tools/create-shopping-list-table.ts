import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerCreateShoppingListTableTool(server: McpServer) {
    server.registerTool("create_shopping_list_table", {
        description: "Format a shopping list locally. Does not modify the cart.",
        inputSchema: { recipe: z.array(z.object({
            ingredient: z.string(), quantity: z.string(), unit_of_measure: z.string(), brand_name: z.string().optional(),
        })) },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ recipe }) => {
        const escape = (text: string) => text.replaceAll("|", "&#124;").replace(/[\r\n]+/g, " ");
        const rows = recipe.map(item => [item.ingredient, item.quantity, item.unit_of_measure, item.brand_name ?? ""].map(escape).join(" | "));
        return { content: [{ type: "text", text: ["| Ingredient | Quantity | Unit | Brand |", "| --- | --- | --- | --- |", ...rows.map(row => `| ${row} |`)].join("\n") }] };
    });
}
