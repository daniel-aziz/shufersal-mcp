import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Page } from "puppeteer";
import { z } from "zod";
import { ShoppingError } from "./shopping/model.js";

const credentialsSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
const itemSchema = z.object({ fields: z.array(z.object({ purpose: z.string().optional(), value: z.string().optional() })) });
export type Credentials = z.infer<typeof credentialsSchema>;
export type OnePasswordConfig = { executable: string; account: string; vault: string; item: string };

export async function readOnePassword(config: OnePasswordConfig): Promise<Credentials> {
    try {
        const run = promisify(execFile);
        const { stdout: session } = await run(config.executable, ["signin", "--account", config.account], { timeout: 60_000, maxBuffer: 64 * 1024 });
        const env = { ...process.env };
        for (const line of session.split("\n").filter(line => line.trim())) {
            const match = /^export (OP_SESSION_[A-Za-z0-9_]+)="([^"\r\n]+)";?$/.exec(line.trim());
            if (!match) throw new Error("Unexpected 1Password session response");
            env[match[1]] = match[2];
        }
        const { stdout } = await run(config.executable,
            ["item", "get", config.item, "--vault", config.vault, "--account", config.account, "--format=json"],
            { timeout: 60_000, maxBuffer: 1024 * 1024, env });
        const item = itemSchema.parse(JSON.parse(stdout));
        return credentialsSchema.parse({
            username: item.fields.find(field => field.purpose === "USERNAME")?.value,
            password: item.fields.find(field => field.purpose === "PASSWORD")?.value,
        });
    } catch {
        throw new ShoppingError("VAULT_UNAVAILABLE", "Unlock 1Password and authorize its CLI integration. Credentials and CLI errors are never returned.");
    }
}

export class ShufersalAuthentication {
    constructor(private readonly credentials: () => Promise<Credentials>, private readonly base = "https://www.shufersal.co.il") {}

    async ensure(page: Page): Promise<{ authenticated: true; reused: boolean }> {
        const origin = new URL(this.base).origin;
        const signedIn = async () => new URL(page.url()).origin === origin
            && Boolean(await page.$("a[href='/online/he/my-account']"));
        if (await signedIn()) return { authenticated: true, reused: true };
        await page.goto(new URL("/online/he/my-account/personal-area/orders/online-orders", origin).href, { waitUntil: "domcontentloaded" });
        if (await signedIn()) return { authenticated: true, reused: true };
        await page.goto(new URL("/online/he/login", origin).href, { waitUntil: "domcontentloaded" });
        const email = "input[name='j_username']";
        const password = "input[name='j_password']";
        let secret: Credentials | undefined;
        try {
            await page.waitForSelector(email, { visible: true });
            await page.waitForSelector(password, { visible: true });
            const valid = await page.$eval(password, (input, expectedOrigin) => input instanceof HTMLInputElement
                && input.type === "password" && location.origin === expectedOrigin
                && input.form?.method.toLowerCase() === "post"
                && new URL(input.form.action).origin === expectedOrigin, origin);
            if (!valid) throw new ShoppingError("UNSAFE_LOGIN_FORM", "The login form does not match the expected secure origin.");
            secret = credentialsSchema.parse(await this.credentials());
            if (new URL(page.url()).origin !== origin) throw new ShoppingError("UNSAFE_LOGIN_FORM", "The login page changed before authentication.");
            await page.$eval(email, input => { if (input instanceof HTMLInputElement) input.value = ""; });
            await page.$eval(password, input => { if (input instanceof HTMLInputElement) input.value = ""; });
            await page.type(email, secret.username);
            await page.type(password, secret.password);
            await Promise.all([
                page.waitForNavigation({ waitUntil: "domcontentloaded" }),
                page.click("::-p-aria(כניסה[role=\"button\"])")
            ]);
            if (!await signedIn()) throw new ShoppingError("AUTHENTICATION_REQUIRED", "Sign-in was not confirmed. Check for a verification challenge; no automatic retry was made.");
            return { authenticated: true, reused: false };
        } catch (error) {
            if (error instanceof ShoppingError) throw error;
            throw new ShoppingError("AUTHENTICATION_REQUIRED", "Sign-in could not be verified. No automatic retry was made; check 1Password or a site verification challenge.");
        } finally {
            secret = undefined;
            try {
                await page.$$eval("input[name='j_username'],input[name='j_password']", inputs => inputs.forEach(input => {
                    if (input instanceof HTMLInputElement) input.value = "";
                }));
            } catch { /* Navigation can destroy the form; never expose a browser error. */ }
        }
    }
}
