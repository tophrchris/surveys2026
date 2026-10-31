#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const SITE_LIMIT_BYTES = 1_000_000_000;
export const FILE_LIMIT_BYTES = 100 * 1024 * 1024;
const metadataFiles = new Set(["index.html", "asset-manifest.json", ".nojekyll"]);
const webExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".svg", ".dzi", ".json"]);
const textExtensions = new Set([".html", ".svg", ".dzi", ".json", ".xml"]);

export function assertAssetPath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.startsWith("/") ||
      /[\\\u0000-\u001f?#%]/.test(relativePath) ||
      relativePath.split("/").some((part) => !part || part === "." || part === "..") ||
      /starfront/i.test(relativePath)) {
    throw new Error(`Unsafe or excluded asset path: ${JSON.stringify(relativePath)}`);
  }
  const vipsMetadata = /^gallery\/explorer\/.+_files\/vips-properties\.xml$/.test(relativePath);
  if (!metadataFiles.has(relativePath) && !webExtensions.has(path.posix.extname(relativePath).toLowerCase()) && !vipsMetadata) {
    throw new Error(`Only web images and derived metadata may be published: ${relativePath}`);
  }
}

export async function inspectPublicAssets(publicDirectory, { siteLimitBytes = SITE_LIMIT_BYTES, fileLimitBytes = FILE_LIMIT_BYTES } = {}) {
  const root = path.resolve(publicDirectory);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Public root must be a real directory: ${root}`);
  const assets = {};
  let totalBytes = 0;
  let fileCount = 0;
  async function visit(directory, prefix = "") {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlinks may not be published: ${relativePath}`);
      if (entry.isDirectory()) {
        if (/starfront/i.test(relativePath) || entry.name.startsWith(".")) throw new Error(`Excluded public directory: ${relativePath}`);
        await visit(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Only regular files may be published: ${relativePath}`);
      assertAssetPath(relativePath);
      const stat = await fs.stat(fullPath);
      if (stat.size > fileLimitBytes) throw new Error(`File exceeds GitHub's ${fileLimitBytes}-byte limit: ${relativePath}`);
      totalBytes += stat.size;
      fileCount += 1;
      if (totalBytes >= siteLimitBytes) throw new Error(`Published site must remain below ${siteLimitBytes} bytes`);
      const bytes = await fs.readFile(fullPath);
      if (textExtensions.has(path.extname(relativePath).toLowerCase()) && /starfront/i.test(bytes.toString("utf8"))) {
        throw new Error(`Excluded draft reference in public file: ${relativePath}`);
      }
      if (!metadataFiles.has(relativePath)) {
        assets[relativePath] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: stat.size };
      }
    }
  }
  await visit(root);
  return { assets: Object.fromEntries(Object.entries(assets).sort(([a], [b]) => a.localeCompare(b))), totalBytes, fileCount };
}

export async function writeAssetManifest(publicDirectory, repository) {
  if (!/^(gallery|surveys|deepzoom)\d{4}$/.test(repository)) throw new Error(`Invalid annual repository name: ${repository}`);
  const inventory = await inspectPublicAssets(publicDirectory);
  const manifest = { version: 1, repository, assets: inventory.assets };
  await fs.writeFile(path.join(publicDirectory, "asset-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return verifyAssets(publicDirectory, { repository });
}

export async function verifyAssets(publicDirectory, { repository, ...limits } = {}) {
  const inventory = await inspectPublicAssets(publicDirectory, limits);
  const manifest = JSON.parse(await fs.readFile(path.join(publicDirectory, "asset-manifest.json"), "utf8"));
  if (manifest.version !== 1 || !/^(gallery|surveys|deepzoom)\d{4}$/.test(manifest.repository) ||
      (repository && manifest.repository !== repository) || !manifest.assets || Array.isArray(manifest.assets)) {
    throw new Error("Invalid asset manifest or unexpected repository");
  }
  const actualPaths = Object.keys(inventory.assets).sort();
  const manifestPaths = Object.keys(manifest.assets).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(manifestPaths)) throw new Error("Asset manifest does not exactly cover the published files");
  for (const relativePath of manifestPaths) {
    assertAssetPath(relativePath);
    const expected = manifest.assets[relativePath];
    const actual = inventory.assets[relativePath];
    if (!expected || !/^[a-f0-9]{64}$/.test(expected.sha256) || expected.sha256 !== actual.sha256 || expected.bytes !== actual.bytes) {
      throw new Error(`Published bytes do not match the manifest: ${relativePath}`);
    }
  }
  return { repository: manifest.repository, assets: actualPaths.length, files: inventory.fileCount, bytes: inventory.totalBytes };
}

async function main() {
  const args = process.argv.slice(2);
  let publicDirectory = "public";
  let repository = process.env.GITHUB_REPOSITORY?.split("/").at(-1);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--public") publicDirectory = args[++i];
    else if (args[i] === "--repository") repository = args[++i];
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  console.log(JSON.stringify(await verifyAssets(publicDirectory, { repository })));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
