import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const envSchema = z.object({
    SHUFERSAL_STATE_DIR: z.string().min(1).default(join(homedir(), ".local", "state", "shufersal-mcp")),
    SHUFERSAL_SITE_PROFILE: z.string().min(1).optional(),
    SHUFERSAL_BROWSER_URL: z.string().url().optional(),
    PUPPETEER_EXECUTABLE_PATH: z.string().min(1).optional(),
    SHUFERSAL_HEADLESS: z.enum(["true", "false"]).default("false"),
    SHUFERSAL_ENABLE_CHECKOUT: z.enum(["true", "false"]).default("false"),
});
export function readConfig() {
    const env = envSchema.parse(process.env);
    const stateDirectory = resolve(env.SHUFERSAL_STATE_DIR);
    return {
        stateDirectory,
        siteProfile: env.SHUFERSAL_SITE_PROFILE,
        checkoutEnabled: env.SHUFERSAL_ENABLE_CHECKOUT === "true",
        browser: {
            profile: join(stateDirectory, "browser"), browserURL: env.SHUFERSAL_BROWSER_URL,
            executablePath: env.PUPPETEER_EXECUTABLE_PATH, headless: env.SHUFERSAL_HEADLESS === "true",
        },
    };
}
