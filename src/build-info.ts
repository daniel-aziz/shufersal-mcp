import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
function digest(directory: string) {
    const hash = createHash("sha256");
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = resolve(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.isFile() && entry.name !== "build-info.json") hash.update(relative(directory, path)).update(readFileSync(path));
        }
    };
    walk(directory); return hash.digest("hex");
}
export function readBuildInfo() {
    const dist = dirname(fileURLToPath(import.meta.url));
    const info = JSON.parse(readFileSync(resolve(dist, "build-info.json"), "utf8"));
    const source = resolve(dist, "../src");
    return { ...info, sourceMatchesBuild: existsSync(source) ? digest(source) === info.sourceDigest : null,
        distMatchesBuild: digest(dist) === info.distDigest };
}
