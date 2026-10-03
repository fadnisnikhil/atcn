#!/usr/bin/env node
// Release guards for the npm packages:
//   1. Every internal @atcn/* dependency must pin the version that package has in this repository.
//   2. A version that is already on npm must contain exactly the published files; otherwise the version needs a bump.
// Check 2 compares the unpacked files, not the .tgz checksum, because gzip output differs between platforms.
// Packages must be built first (npm ci builds them). With --strict, check 2 fails instead of warning.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const strict = process.argv.includes("--strict");
const inGitHubActions = process.env.GITHUB_ACTIONS === "true";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const workspaces = root.workspaces.map((dir) => ({ dir, manifest: JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) }));
const versions = new Map(workspaces.map(({ manifest }) => [manifest.name, manifest.version]));
const errors = [];
const warnings = [];

for (const { dir, manifest } of workspaces) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [name, pinned] of Object.entries(manifest[field] ?? {})) {
      if (versions.has(name) && pinned !== versions.get(name)) {
        errors.push(`${dir}/package.json: ${field}["${name}"] is "${pinned}", but ${name} is ${versions.get(name)} in this repository`);
      }
    }
  }
}

function npm(args, cwd = ".") {
  return execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function isPublished(id) {
  try {
    return npm(["view", id, "version"]).trim() !== "";
  } catch (error) {
    if (String(error.stderr).includes("E404")) return false;
    throw error;
  }
}

/** Runs `npm pack <args>` in `cwd`, unpacks the tarball inside `destination`, and returns the unpacked directory. */
function packAndUnpack(args, cwd, destination) {
  mkdirSync(destination, { recursive: true });
  const [{ filename }] = JSON.parse(npm(["pack", ...args, "--pack-destination", destination, "--json"], cwd));
  execFileSync("tar", ["-xzf", join(destination, filename), "-C", destination]);
  return join(destination, "package");
}

function filesIn(dir) {
  return readdirSync(dir, { recursive: true }).filter((name) => statSync(join(dir, name)).isFile());
}

function changedFiles(publishedDir, builtDir) {
  const names = [...new Set([...filesIn(publishedDir), ...filesIn(builtDir)])].sort();
  return names.filter((name) => {
    const published = join(publishedDir, name);
    const built = join(builtDir, name);
    return !existsSync(published) || !existsSync(built) || !readFileSync(published).equals(readFileSync(built));
  });
}

const scratch = mkdtempSync(join(tmpdir(), "atcn-check-versions-"));
try {
  for (const { dir, manifest } of workspaces) {
    const id = `${manifest.name}@${manifest.version}`;
    if (!isPublished(id)) {
      console.log(`${id}: not on npm yet; it will be published`);
      continue;
    }
    const scratchDir = join(scratch, manifest.name.replace("/", "__"));
    const publishedDir = packAndUnpack([id], scratch, join(scratchDir, "published"));
    const builtDir = packAndUnpack(["--workspace", dir], ".", join(scratchDir, "built"));
    const changed = changedFiles(publishedDir, builtDir);
    if (changed.length === 0) {
      console.log(`${id}: unchanged since it was published`);
    } else {
      (strict ? errors : warnings).push(`${id} is already published, but these files changed: ${changed.join(", ")}. Bump the version in ${dir}/package.json and the pins that point at it.`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

for (const message of warnings) console.log(inGitHubActions ? `::warning::${message}` : `warning: ${message}`);
for (const message of errors) console.error(inGitHubActions ? `::error::${message}` : `error: ${message}`);
process.exitCode = errors.length > 0 ? 1 : 0;
