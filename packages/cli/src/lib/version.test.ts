import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGX_CLI_VERSION } from "./version";

describe("AGX_CLI_VERSION", () => {
	it("matches the published package version", () => {
		const pkg = JSON.parse(
			readFileSync(
				new URL("../../package.json", import.meta.url),
				"utf8",
			),
		) as { version: string };
		expect(AGX_CLI_VERSION).toBe(pkg.version);
	});
});

describe("the gateway container", () => {
	it("installs and is tagged with this release", () => {
		const read = (file: string) =>
			readFileSync(new URL(`../../../../deploy/gateway/${file}`, import.meta.url), "utf8");
		expect(read("Dockerfile")).toContain(`ARG AGX_PACKAGE=@nostr-agx/cli@${AGX_CLI_VERSION}\n`);
		expect(read("compose.yaml")).toContain(`image: agx-gateway:${AGX_CLI_VERSION}\n`);
	});
});
