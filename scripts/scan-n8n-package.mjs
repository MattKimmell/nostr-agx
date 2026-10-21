#!/usr/bin/env node
/**
 * Run n8n's community-package scanner on a package as it would be published:
 * the checks n8n makes before it verifies a package for n8n Cloud.
 *
 *   node scripts/scan-n8n-package.mjs <scanner dir> <package dir> [--allow <rule>]...
 *
 * <scanner dir> is where `@n8n/scan-community-package` is installed; CI
 * installs a pinned version there, so it is not a dependency of this
 * repository. As n8n does, this lints the package's source (`package.json`,
 * `nodes/`, `credentials/`) and the compiled `.js` files and `package.json` of
 * the tarball `pnpm pack` makes, with the scanner's own configuration.
 *
 * `--allow <rule>` reports a rule's findings without failing, for a known gap
 * that is tracked elsewhere.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const allowed = new Set();
const positional = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--allow") {
		allowed.add(args[++i]);
	} else {
		positional.push(args[i]);
	}
}
const [scannerDir, packageArg] = positional;
if (!scannerDir || !packageArg) {
	console.error("Usage: node scripts/scan-n8n-package.mjs <scanner dir> <package dir> [--allow <rule>]...");
	process.exit(2);
}

const scannerRoot = join(resolve(scannerDir), "node_modules", "@n8n", "scan-community-package");
const scanner = await import(pathToFileURL(join(scannerRoot, "scanner", "scanner.mjs")).href);
// ESLint as the scanner resolves it, so its configuration loads as in n8n.
const { ESLint } = await import(
	pathToFileURL(join(resolve(scannerDir), "node_modules", "eslint", "lib", "api.js")).href
);
const fg = (await import(pathToFileURL(join(resolve(scannerDir), "node_modules", "fast-glob", "out", "index.js")).href))
	.default;

const packageDir = resolve(packageArg);
const out = mkdtempSync(join(tmpdir(), "scan-n8n-"));
let failed = false;
try {
	const packed = spawnSync("pnpm", ["pack", "--pack-destination", out], { cwd: packageDir, encoding: "utf8" });
	if (packed.status !== 0) {
		throw new Error(`pnpm pack failed:\n${packed.stderr || packed.stdout}`);
	}
	const tarball = readdirSync(out).find((file) => file.endsWith(".tgz"));
	if (!tarball) {
		throw new Error("pnpm pack wrote no tarball");
	}
	const extracted = join(out, "extracted");
	spawnSync("mkdir", ["-p", extracted]);
	const untar = spawnSync("tar", ["-xzf", join(out, tarball), "-C", extracted], { encoding: "utf8" });
	if (untar.status !== 0) {
		throw new Error(`tar failed: ${untar.stderr}`);
	}

	const config = await scanner.buildScanConfig();
	const scan = async (label, dir, patterns) => {
		const eslint = new ESLint({ cwd: dir, allowInlineConfig: false, overrideConfigFile: true, overrideConfig: config });
		const files = fg.sync(patterns, { cwd: dir, absolute: true, ignore: ["node_modules/**", "**/package-lock.json"] });
		if (files.length === 0) {
			console.error(`${label}: no files to scan`);
			failed = true;
			return;
		}
		const results = await eslint.lintFiles(files);
		let errors = 0;
		for (const result of results) {
			for (const message of result.messages) {
				if (message.severity !== 2) {
					continue;
				}
				const rule = message.ruleId ?? "parse-error";
				const where = `${relative(dir, result.filePath)}:${message.line}`;
				if (allowed.has(rule)) {
					console.warn(`${label}: allowed ${rule} at ${where}: ${message.message}`);
				} else {
					console.error(`${label}: ${rule} at ${where}: ${message.message}`);
					errors += 1;
				}
			}
		}
		console.log(`${label}: ${files.length} files, ${errors} error${errors === 1 ? "" : "s"}`);
		if (errors > 0) {
			failed = true;
		}
	};
	await scan("source", packageDir, scanner.SOURCE_FILE_PATTERNS);
	await scan("tarball", join(extracted, "package"), ["**/*.js", "package.json"]);
} finally {
	rmSync(out, { recursive: true, force: true });
}
if (failed) {
	console.error("\nn8n's scanner would not accept this package.");
	process.exitCode = 1;
}
