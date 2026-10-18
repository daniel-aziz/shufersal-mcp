import puppeteer, { type Browser, type Page } from "puppeteer";
import { mkdir, chmod } from "node:fs/promises";
import { ShoppingError } from "./shopping/model.js";

export class BrowserSession {
    private browser: Browser | undefined;
    private page: Page | undefined;
    constructor(private readonly options: { profile: string; browserURL?: string; executablePath?: string; headless: boolean }) {}
    async getPage(): Promise<Page> {
        if (this.page && !this.page.isClosed()) return this.page;
        if (!this.browser?.connected) {
            if (this.options.browserURL) {
                const url = new URL(this.options.browserURL);
                if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
                    throw new ShoppingError("INVALID_BROWSER_URL", "Only a local browser endpoint is supported.");
                }
                this.browser = await puppeteer.connect({ browserURL: url.href });
            } else {
                await mkdir(this.options.profile, { recursive: true, mode: 0o700 });
                await chmod(this.options.profile, 0o700);
                this.browser = await puppeteer.launch({ userDataDir: this.options.profile, headless: this.options.headless, executablePath: this.options.executablePath });
            }
        }
        this.page = await this.browser.newPage();
        this.page.setDefaultTimeout(15_000);
        this.page.setDefaultNavigationTimeout(30_000);
        this.page.on("dialog", async dialog => { await dialog.dismiss(); });
        return this.page;
    }
    async close(): Promise<void> {
        await this.page?.close();
        if (this.options.browserURL) this.browser?.disconnect();
        else await this.browser?.close();
    }
}
