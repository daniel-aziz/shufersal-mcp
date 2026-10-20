import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const envSchema = z.object({
    SHUFERSAL_STATE_DIR: z.string().min(1).default(join(homedir(), ".local", "state", "shufersal-mcp")),
    SHUFERSAL_SITE_MODE: z.enum(["profile", "live"]).default("profile"),
    SHUFERSAL_AUTH_ITEM: z.string().min(1).optional(),
    SHUFERSAL_AUTH_VAULT: z.string().min(1).optional(),
    SHUFERSAL_AUTH_ACCOUNT: z.string().min(1).optional(),
    SHUFERSAL_OP_EXECUTABLE: z.string().min(1).default("op"),
    SHUFERSAL_SITE_PROFILE: z.string().min(1).optional(),
    SHUFERSAL_BROWSER_URL: z.string().url().optional(),
    PUPPETEER_EXECUTABLE_PATH: z.string().min(1).optional(),
    SHUFERSAL_HEADLESS: z.enum(["true", "false"]).default("false"),
    SHUFERSAL_ENABLE_CHECKOUT: z.enum(["true", "false"]).default("false"),
});
export function readConfig() {
    const local = process.env.SHUFERSAL_CONFIG_FILE ? z.record(z.string()).parse(JSON.parse(readFileSync(process.env.SHUFERSAL_CONFIG_FILE, "utf8"))) : {};
    const env = envSchema.parse({ ...local, ...process.env });
    const authValues = [env.SHUFERSAL_AUTH_ITEM, env.SHUFERSAL_AUTH_VAULT, env.SHUFERSAL_AUTH_ACCOUNT];
    if (authValues.some(Boolean) && !authValues.every(Boolean)) throw new Error("Configure all 1Password reference fields together");
    const authentication = env.SHUFERSAL_AUTH_ITEM && env.SHUFERSAL_AUTH_VAULT && env.SHUFERSAL_AUTH_ACCOUNT ? {
        item: env.SHUFERSAL_AUTH_ITEM, vault: env.SHUFERSAL_AUTH_VAULT, account: env.SHUFERSAL_AUTH_ACCOUNT, executable: env.SHUFERSAL_OP_EXECUTABLE,
    } : undefined;
    const stateDirectory = resolve(env.SHUFERSAL_STATE_DIR);
    return {
        stateDirectory, authentication, siteMode: env.SHUFERSAL_SITE_MODE,
        siteProfile: env.SHUFERSAL_SITE_PROFILE,
        checkoutEnabled: env.SHUFERSAL_ENABLE_CHECKOUT === "true",
        browser: {
            profile: join(stateDirectory, "browser"), browserURL: env.SHUFERSAL_BROWSER_URL,
            executablePath: env.PUPPETEER_EXECUTABLE_PATH, headless: env.SHUFERSAL_HEADLESS === "true",
        },
    };
}
