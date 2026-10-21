#!/usr/bin/env node
import { readBuildInfo } from "./build-info.js";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ShufersalAuthentication, readOnePassword } from "./authentication.js";
import { ShoppingError } from "./shopping/model.js";
import { BrowserSession } from "./browser.js";
import { readConfig } from "./config.js";
import { ShoppingService } from "./shopping/service.js";
import { LiveShufersalSite } from "./shopping/live.js";
import { BrowserShoppingSite } from "./shopping/site.js";
import { siteProfileSchema } from "./shopping/site-profile.js";
import { FileJournal } from "./shopping/state.js";
import { OperationOwnership } from "./shopping/ownership.js";
import { registerShoppingTools } from "./tools/shopping.js";
import { registerCreateShoppingListTableTool } from "./tools/create-shopping-list-table.js";

async function main() {
    const build = readBuildInfo();
    const config = readConfig();
    const profile = config.siteProfile ? siteProfileSchema.parse(JSON.parse(await readFile(config.siteProfile, "utf8"))) : undefined;
    const browser = new BrowserSession(config.browser);
    const authConfig = config.authentication;
    const authentication = authConfig ? new ShufersalAuthentication(() => readOnePassword(authConfig)) : undefined;
    const authenticate = authentication ? async (page: import("puppeteer").Page) => { await authentication.ensure(page); } : undefined;
    const site = config.siteMode === "live" ? new LiveShufersalSite(() => browser.getPage(), authenticate)
        : new BrowserShoppingSite(() => browser.getPage(), profile, undefined, authenticate);
    const ownership = new OperationOwnership(config.stateDirectory, () => browser.close());
    const service = new ShoppingService(site, new FileJournal(config.stateDirectory), config.checkoutEnabled, undefined, ownership);
    const server = new McpServer({ name: "shufersal-mcp-server", version: `${build.version}+${build.buildId.slice(0, 12)}` });
    server.registerResource("build", "shufersal://build", { description: "Installed build provenance and source/dist freshness; reconnect after rebuilding.", mimeType: "application/json" }, async uri => {
        const installed = readBuildInfo();
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ ...build,
            runningBuildMatchesInstalled: installed.buildId === build.buildId, installed }) }] };
    });
    server.registerTool("authenticate_shufersal", {
        description: "Reuse the local session or sign in with operator-configured 1Password references. Never accepts or returns credentials.",
        inputSchema: {}, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async () => {
        try {
            if (!authentication) throw new ShoppingError("AUTH_NOT_CONFIGURED", "Configure local 1Password item, vault and account references first.");
            const result = await service.run(async () => authentication.ensure(await browser.getPage()));
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, result }) }] };
        } catch (error) {
            const code = error instanceof ShoppingError ? error.code : "AUTHENTICATION_REQUIRED";
            return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code, message: error instanceof ShoppingError ? error.message : "Authentication could not be verified." } }) }] };
        }
    });
    registerShoppingTools(server, service);
    registerCreateShoppingListTableTool(server);
    let closing = false;
    const close = async () => {
        if (closing) return;
        closing = true;
        await service.shutdown();
    };
    process.on("SIGINT", async () => { await close(); process.exit(0); });
    process.on("SIGTERM", async () => { await close(); process.exit(0); });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stdin.on("end", async () => { await close(); });
}
try { await main(); }
catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof ShoppingError ? { code: error.code, message: error.message }
        : { code: "STARTUP_FAILED", message: "Check configuration, site profile and build metadata; run npm run build and reconnect. Sensitive details suppressed." } }));
    process.exitCode = 1;
}
