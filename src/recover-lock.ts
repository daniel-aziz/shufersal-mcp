#!/usr/bin/env node
import { readConfig } from "./config.js";
import { recoverOwnership, inspectOwnership } from "./shopping/state.js";
import { ShoppingError } from "./shopping/model.js";
try {
    const args = process.argv.slice(2);
    const directory = readConfig().stateDirectory;
    const fingerprintIndex = args.indexOf("--expected-lock-sha256");
    const approval = fingerprintIndex >= 0 ? { expectedFingerprint: args[fingerprintIndex + 1], confirmLegacyLocalOwner: args.includes("--confirm-legacy-local-owner") } : undefined;
    if (args.includes("--confirm-legacy-local-owner") && !approval?.expectedFingerprint) throw new ShoppingError("APPROVAL_REQUIRED", "Inspect first and provide the reviewed --expected-lock-sha256 with legacy ownership confirmation.");
    const result = args.includes("--recover") ? await recoverOwnership(directory, approval) : await inspectOwnership(directory);
    console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof ShoppingError ? { code: error.code, message: error.message }
        : { code: "CONFIGURATION_INVALID", message: "Verify the same configuration used by the MCP. Sensitive details suppressed." } }));
    process.exitCode = 1;
}
