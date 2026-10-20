import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { gatewayKeysPath, writePrivateJson } from "../paths.js";

/**
 * API keys for `agx gateway`.
 *
 * The gateway signs and decrypts as this profile's agent, so its HTTP API is as
 * sensitive as the secret key: every route but `/v1/health` needs a key. Only a
 * SHA-256 hash of each key is kept, so the file is not a key list; a key is
 * shown once, when it is made. The file is read on every request, so a key
 * made or revoked while the gateway runs takes effect at once.
 *
 * `AGX_GATEWAY_KEY` is accepted too, for a container whose secrets come from
 * its environment rather than its disk.
 */

const KEY_PREFIX = "agxg_";
export const GATEWAY_KEY_ENV = "AGX_GATEWAY_KEY";

const storedKeySchema = z.object({
	id: z.string(),
	label: z.string(),
	/** SHA-256 of the key, hex. */
	hash: z.string().regex(/^[0-9a-f]{64}$/),
	createdAt: z.string(),
});
const keysFileSchema = z.object({
	version: z.literal(1),
	keys: z.array(storedKeySchema).default([]),
});

export type GatewayKey = Omit<z.infer<typeof storedKeySchema>, "hash">;

function hashKey(key: string): Buffer {
	return createHash("sha256").update(key, "utf8").digest();
}

function readKeys(profile: string): z.infer<typeof storedKeySchema>[] {
	const path = gatewayKeysPath(profile);
	if (!existsSync(path)) {
		return [];
	}
	const parsed = keysFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
	if (!parsed.success) {
		throw new Error(`${path} is not a gateway key file this version can read`);
	}
	return parsed.data.keys;
}

function writeKeys(profile: string, keys: z.infer<typeof storedKeySchema>[]): void {
	writePrivateJson(gatewayKeysPath(profile), { version: 1, keys });
}

/** Make a key; the returned `key` is the only copy there will ever be. */
export function createGatewayKey(
	profile: string,
	label: string,
): GatewayKey & { key: string } {
	const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
	const stored = {
		id: randomBytes(4).toString("hex"),
		label,
		hash: hashKey(key).toString("hex"),
		createdAt: new Date().toISOString(),
	};
	writeKeys(profile, [...readKeys(profile), stored]);
	return { id: stored.id, label, createdAt: stored.createdAt, key };
}

export function listGatewayKeys(profile: string): GatewayKey[] {
	return readKeys(profile).map(({ hash: _hash, ...key }) => key);
}

/** Revoke a key by id. False when there is no such key. */
export function revokeGatewayKey(profile: string, id: string): boolean {
	const keys = readKeys(profile);
	const kept = keys.filter((key) => key.id !== id);
	if (kept.length === keys.length) {
		return false;
	}
	writeKeys(profile, kept);
	return true;
}

/** Whether any key could be presented: one in the file, or the env one. */
export function gatewayKeysConfigured(profile: string): boolean {
	return Boolean(process.env[GATEWAY_KEY_ENV]) || readKeys(profile).length > 0;
}

/**
 * Check a presented key. Every candidate is compared, in constant time per
 * comparison, so how long a check takes says nothing about which key came
 * close. Returns the matching key's id (`env` for `AGX_GATEWAY_KEY`), or null.
 */
export function verifyGatewayKey(profile: string, presented: string): string | null {
	if (!presented.startsWith(KEY_PREFIX) && presented !== process.env[GATEWAY_KEY_ENV]) {
		return null;
	}
	const hash = hashKey(presented);
	let match: string | null = null;
	const envKey = process.env[GATEWAY_KEY_ENV];
	if (envKey && timingSafeEqual(hash, hashKey(envKey))) {
		match = "env";
	}
	for (const key of readKeys(profile)) {
		if (timingSafeEqual(hash, Buffer.from(key.hash, "hex")) && match === null) {
			match = key.id;
		}
	}
	return match;
}
