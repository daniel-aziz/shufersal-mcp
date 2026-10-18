#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserSession } from "./browser.js";
import { readConfig } from "./config.js";
import { ShoppingService } from "./shopping/service.js";
import { BrowserShoppingSite } from "./shopping/site.js";
import { siteProfileSchema } from "./shopping/site-profile.js";
import { acquireOwnership, FileJournal } from "./shopping/state.js";
import { registerShoppingTools } from "./tools/shopping.js";
import { registerCreateShoppingListTableTool } from "./tools/create-shopping-list-table.js";

async function main() {
    const config = readConfig();
    const profile = config.siteProfile ? siteProfileSchema.parse(JSON.parse(await readFile(config.siteProfile, "utf8"))) : undefined;
    const release = await acquireOwnership(config.stateDirectory);
    const browser = new BrowserSession(config.browser);
    const service = new ShoppingService(new BrowserShoppingSite(() => browser.getPage(), profile), new FileJournal(config.stateDirectory), config.checkoutEnabled);
    const server = new McpServer({ name: "shufersal-mcp-server", version: "0.0.1" });
    registerShoppingTools(server, service);
    registerCreateShoppingListTableTool(server);
    let closing = false;
    const close = async () => {
        if (closing) return;
        closing = true;
        await service.run(async () => {
            await browser.close();
            await release();
        });
    };
    process.on("SIGINT", async () => { await close(); process.exit(0); });
    process.on("SIGTERM", async () => { await close(); process.exit(0); });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stdin.on("end", async () => { await close(); });
}
try { await main(); }
catch { console.error("Shufersal MCP failed to start. Check configuration, site profile and ownership lock. Sensitive error details are suppressed."); process.exitCode = 1; }
