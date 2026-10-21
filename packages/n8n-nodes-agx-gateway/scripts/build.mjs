/**
 * Build what n8n loads: plain `tsc` to CommonJS (n8n `require`s community
 * nodes), then the icons and codex files next to the code that names them.
 * Nothing is bundled: the nodes use only `n8n-workflow`, which n8n supplies,
 * and Node's own `crypto`, so the package has no runtime dependencies — what n8n
 * requires of a node it verifies for n8n Cloud.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
rmSync("dist", { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"], {
	stdio: "inherit",
});
mkdirSync("dist/icons", { recursive: true });
for (const icon of ["agx.svg", "agx.dark.svg"]) {
	cpSync(`icons/${icon}`, `dist/icons/${icon}`);
}
for (const node of ["AgxGateway", "AgxGatewayTrigger"]) {
	cpSync(`nodes/${node}/${node}.node.json`, `dist/nodes/${node}/${node}.node.json`);
}
