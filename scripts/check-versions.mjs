#!/usr/bin/env node
// Release guards for the npm packages:
//   1. Every internal @atcn/* dependency must pin the version that package has in this repository.
//   2. A version that is already on npm must contain exactly the published files; otherwise the version needs a bump.
// Packages must be built first (npm ci builds them). With --strict, check 2 fails instead of warning.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

function npm(args) {
  return execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The published tarball's integrity, or null if this version is not on npm. */
function publishedIntegrity(id) {
  try {
    return npm(["view", id, "dist.integrity"]).trim() || null;
  } catch (error) {
    if (String(error.stderr).includes("E404")) return null;
    throw error;
  }
}

for (const { dir, manifest } of workspaces) {
  const id = `${manifest.name}@${manifest.version}`;
  const published = publishedIntegrity(id);
  if (published === null) {
    console.log(`${id}: not on npm yet; it will be published`);
    continue;
  }
  const built = JSON.parse(npm(["pack", "--dry-run", "--json", "--workspace", dir]))[0].integrity;
  if (built === published) {
    console.log(`${id}: unchanged since it was published`);
  } else {
    (strict ? errors : warnings).push(`${id}: the files differ from the published ${id}. Bump the version in ${dir}/package.json and the pins that point at it.`);
  }
}

for (const message of warnings) console.log(inGitHubActions ? `::warning::${message}` : `warning: ${message}`);
for (const message of errors) console.error(inGitHubActions ? `::error::${message}` : `error: ${message}`);
process.exitCode = errors.length > 0 ? 1 : 0;
