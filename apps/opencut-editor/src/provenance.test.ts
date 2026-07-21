import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OPEN_CUT_TIMELINE_TYPES_UPSTREAM_SHA256 } from "./canonical-timeline-codec.js";
import { OPEN_CUT_CLASSIC_COMMIT } from "./opencut-timeline-engine.js";

interface SourceManifest {
	upstream: { commit: string; license: string };
	schemaSources: Array<{
		upstreamPath: string;
		upstreamSha256: string;
		consumer: string;
		policy: string;
	}>;
	files: Array<{
		localPath: string;
		upstreamPath: string;
		upstreamSha256: string;
		localSha256: string;
		patches: string[];
	}>;
	localCompatibilityPorts: string[];
}

const extractionRoot = new URL(
	"../../../third_party/OpenCut-Classic/",
	import.meta.url,
);

async function collectTypeScriptFiles(relativeDirectory: string): Promise<string[]> {
	const entries = await readdir(
		new URL(`${relativeDirectory}/`, extractionRoot),
		{ withFileTypes: true },
	);
	const nested = await Promise.all(
		entries.map(async (entry): Promise<string[]> => {
			const relativePath = `${relativeDirectory}/${entry.name}`;
			return entry.isDirectory()
				? collectTypeScriptFiles(relativePath)
				: relativePath.endsWith(".ts")
					? [relativePath]
					: [];
		}),
	);
	return nested.flat();
}

test("controlled extraction files match their checked-in provenance manifest", async () => {
	const manifest = JSON.parse(
		await readFile(new URL("UPSTREAM_SOURCES.json", extractionRoot), "utf8"),
	) as SourceManifest;
	const commitMarker = (
		await readFile(new URL("UPSTREAM_COMMIT", extractionRoot), "utf8")
	).trim();

	assert.equal(manifest.upstream.commit, OPEN_CUT_CLASSIC_COMMIT);
	assert.equal(commitMarker, OPEN_CUT_CLASSIC_COMMIT);
	assert.equal(manifest.upstream.license, "MIT");
	assert.deepEqual(manifest.schemaSources, [
		{
			upstreamPath: "apps/web/src/timeline/types.ts",
			upstreamSha256: OPEN_CUT_TIMELINE_TYPES_UPSTREAM_SHA256,
			consumer: "apps/opencut-editor/src/canonical-timeline-codec.ts",
			policy:
				"Pinned discriminated unions encoded as lossless JSON; browser-only AudioBuffer and Date values are excluded from timeline persistence",
		},
	]);
	assert.equal(
		new Set(manifest.files.map((source) => source.localPath)).size,
		manifest.files.length,
		"manifest local paths must be unique",
	);

	for (const source of manifest.files) {
		assert.match(source.upstreamSha256, /^[0-9a-f]{64}$/);
		assert.match(source.localSha256, /^[0-9a-f]{64}$/);
		assert.ok(source.upstreamPath.length > 0);
		assert.ok(Array.isArray(source.patches));
		const bytes = await readFile(new URL(source.localPath, extractionRoot));
		const digest = createHash("sha256").update(bytes).digest("hex");
		assert.equal(
			digest,
			source.localSha256,
			`${fileURLToPath(new URL(source.localPath, extractionRoot))} drifted`,
		);
	}

	const declaredFiles = [
		...manifest.files.map((source) => source.localPath),
		...manifest.localCompatibilityPorts,
	].sort();
	assert.deepEqual(
		(await collectTypeScriptFiles("src")).sort(),
		declaredFiles,
		"every extracted TypeScript file must be hashed or declared as a local compatibility port",
	);
});

test("the complete upstream MIT license is retained", async () => {
	const license = await readFile(new URL("LICENSE", extractionRoot), "utf8");
	assert.match(license, /Copyright 2025-2026 OpenCut/);
	assert.match(license, /Permission is hereby granted, free of charge/);
	assert.match(license, /THE SOFTWARE IS PROVIDED .*AS IS/);
});
