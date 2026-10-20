#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { BrowserSession } from "./browser.js";
import { readConfig } from "./config.js";
import { LiveShufersalSite } from "./shopping/live.js";
import { ShoppingError } from "./shopping/model.js";
import { ShoppingService } from "./shopping/service.js";
import { acquireOwnership, FileJournal } from "./shopping/state.js";

async function main() {
    const { values } = parseArgs({ options: { operation: { type: "string" }, resolution: { type: "string" }, help: { type: "boolean" } } });
    if (values.help) {
        console.log("Usage: npm run recover:cart -- --operation <original UUID> [--resolution <stable resolution UUID>]. Requires a local operator terminal. No cart writes; checkout is unavailable.");
        return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new ShoppingError("OPERATOR_TERMINAL_REQUIRED", "Recovery requires an interactive local operator terminal. Piped or MCP confirmation is not accepted.");
    const operationId = z.string().uuid().parse(values.operation);
    const resolutionId = z.string().uuid().parse(values.resolution ?? randomUUID());
    const config = readConfig();
    if (config.siteMode !== "live" || config.browser.browserURL) throw new ShoppingError("DEDICATED_BROWSER_REQUIRED", "Recovery requires the dedicated local live browser. Stop the MCP server before running this command.");
    const release = await acquireOwnership(config.stateDirectory);
    const browser = new BrowserSession(config.browser);
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const journal = new FileJournal(config.stateDirectory);
        // The operator command reuses the saved session; it never requests or changes credentials.
        const site = new LiveShufersalSite(() => browser.getPage());
        const actor = `local:${userInfo().username}:uid:${userInfo().uid}`;
        const service = new ShoppingService(site, journal, false, async (assessment, input) => {
            console.log(JSON.stringify({ actor, resolutionId: input.resolutionId, reason: input.reason, ...assessment }, null, 2));
            console.log("This retires the old intent while its historical outcome remains UNKNOWN. No cart quantities will change.");
            const stopped = await terminal.question("Have you stopped other workers and investigated outstanding requests? Type STOPPED AND INVESTIGATED: ");
            if (stopped !== "STOPPED AND INVESTIGATED") throw new ShoppingError("OPERATOR_DECLINED", "No resolution recorded.");
            console.log("Colleagues or delayed remote writes may still change the cart. You are accepting this uncertainty, not verifying the old write.");
            const phrase = `ACCEPT ${assessment.operationId} AT ${assessment.currentQuantity} UNKNOWN`;
            const answer = await terminal.question(`Type exactly '${phrase}' to accept the displayed current state: `);
            if (answer !== phrase) throw new ShoppingError("OPERATOR_DECLINED", "No resolution recorded.");
            return { actor, channel: "local_terminal", workersStopped: true, requestsInvestigated: true, acceptsUnknownOutcome: true };
        });
        const existing = await service.operation(operationId);
        if (existing.status === "resolved_by_operator") {
            console.log(JSON.stringify({ status: existing.status, resolutionId: existing.resolution?.resolutionId, historicalOutcome: "unknown", message: "Already retired; no write or new resolution performed." }));
            return;
        }
        const assessment = await service.assessCartOperation(operationId);
        console.log(`Resolution ID (retain for audit): ${resolutionId}`);
        const reason = await terminal.question("Reason for abandoning the original intent and accepting current state: ");
        const resolution = await service.acceptCurrentCartState({ operationId, resolutionId, expectedRevision: assessment.currentRevision, reason });
        console.log(JSON.stringify({ operationId, resolutionId: resolution?.resolutionId, status: "resolved_by_operator", historicalOutcome: "unknown", cartModified: false }));
    } finally {
        terminal.close();
        try { await browser.close(); } finally { await release(); }
    }
}
try { await main(); }
catch (error) {
    console.error(error instanceof ShoppingError ? `${error.code}: ${error.message}` : "Recovery could not be verified; preserve the ledger and inspect it. No cart mutation was requested.");
    process.exitCode = 1;
}
