#!/usr/bin/env node
// Every npm package and the Python package share one version.
//
//   node scripts/release.mjs check            the version agrees everywhere: package.json files, internal @atcn/* pins,
//                                             pyproject.toml, and the version constants in the source
//   node scripts/release.mjs set <version>    set that version everywhere, including package-lock.json
//   node scripts/release.mjs plan [--strict]  compare the repository with npm and PyPI and decide what to release:
//       bump     a package changed since its published version, so everything moves to the next patch version
//       publish  the repository's version is not on npm or PyPI yet (for example after `set 1.4.0`)
//       none     everything is published and unchanged
//     In GitHub Actions the decision goes to the step outputs `action` and `version`.
//     --strict fails on `bump`; the publish jobs use it so a changed package is never skipped silently.
//
// Packages are compared by their unpacked files, not archive checksums, because gzip output differs between platforms.
// `plan` needs built packages (npm ci builds them).
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PYTHON_DIR = "packages/sdk-python";
const PYTHON_TOP_LEVEL_FILES = ["pyproject.toml", "README.md", "LICENSE"];
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies"];
const VERSION_CONSTANTS = [
  { file: "packages/sdk-ts/src/client.ts", pattern: /(export const SDK_VERSION = ")([^"]+)(")/ },
  { file: "packages/subledger/src/documents.ts", pattern: /(export const SUBLEDGER_VERIFIER_VERSION = ")([^"]+)(")/ },
  { file: "examples/local-runner/src/cli.ts", pattern: /(const VERSION = ")([^"]+)(")/ },
  { file: `${PYTHON_DIR}/src/atcn/client.py`, pattern: /(SDK_VERSION = ")([^"]+)(")/ },
  { file: `${PYTHON_DIR}/pyproject.toml`, pattern: /^(version = ")([^"]+)(")/m },
];

const inGitHubActions = process.env.GITHUB_ACTIONS === "true";
const workspaces = readJson("package.json").workspaces.map((dir) => ({ dir, file: `${dir}/package.json`, manifest: readJson(`${dir}/package.json`) }));
const workspaceNames = new Set(workspaces.map(({ manifest }) => manifest.name));

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function printError(message) {
  console.error(inGitHubActions ? `::error::${message}` : `error: ${message}`);
}

/** The version in a source file; the pattern must match exactly once. */
function readConstant({ file, pattern }) {
  const text = readFileSync(file, "utf8");
  const matches = text.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? [];
  if (matches.length !== 1) throw new Error(`${file}: expected one match for ${pattern}, found ${matches.length}`);
  return { text, version: text.match(pattern)[2] };
}

/** Returns the shared version, or exits listing every place that disagrees with it. */
function check() {
  const version = workspaces[0].manifest.version;
  const problems = [];
  for (const { file, manifest } of workspaces) {
    if (manifest.version !== version) problems.push(`${file}: version is ${manifest.version}, expected ${version}`);
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, pinned] of Object.entries(manifest[field] ?? {})) {
        if (workspaceNames.has(name) && pinned !== version) problems.push(`${file}: ${field}["${name}"] is "${pinned}", expected "${version}"`);
      }
    }
  }
  for (const constant of VERSION_CONSTANTS) {
    const found = readConstant(constant).version;
    if (found !== version) problems.push(`${constant.file}: version is ${found}, expected ${version}`);
  }
  if (problems.length > 0) {
    problems.forEach(printError);
    printError(`All packages share one version. Set it everywhere with: npm run set-version -- <version>`);
    process.exit(1);
  }
  console.log(`Every package is at ${version}`);
  return version;
}

function set(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error(`usage: node scripts/release.mjs set <major.minor.patch>`);
  for (const { file, manifest } of workspaces) {
    manifest.version = version;
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (workspaceNames.has(name)) manifest[field][name] = version;
      }
    }
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  for (const constant of VERSION_CONSTANTS) {
    writeFileSync(constant.file, readConstant(constant).text.replace(constant.pattern, `$1${version}$3`));
  }
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { stdio: "inherit" });
  console.log(`Every package is now at ${version}`);
}

function npm(args, cwd = ".") {
  return execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function filesIn(dir) {
  return readdirSync(dir, { recursive: true }).filter((name) => statSync(join(dir, name)).isFile());
}

function changedFiles(publishedDir, localDir, include = () => true) {
  const names = [...new Set([...filesIn(publishedDir), ...filesIn(localDir)])].filter(include).sort();
  return names.filter((name) => {
    const published = join(publishedDir, name);
    const local = join(localDir, name);
    return !existsSync(published) || !existsSync(local) || !readFileSync(published).equals(readFileSync(local));
  });
}

/** Runs `npm pack <args>` in `cwd`, unpacks the tarball inside `destination`, and returns the unpacked directory. */
function packAndUnpack(args, cwd, destination) {
  mkdirSync(destination, { recursive: true });
  const [{ filename }] = JSON.parse(npm(["pack", ...args, "--pack-destination", destination, "--json"], cwd));
  execFileSync("tar", ["-xzf", join(destination, filename), "-C", destination]);
  return join(destination, "package");
}

/** `changed` lists the files that differ from the published version; null when this version is not published. */
function npmStatus({ dir, manifest }, scratch) {
  const id = `${manifest.name}@${manifest.version}`;
  try {
    if (npm(["view", id, "version"]).trim() === "") return { id, changed: null };
  } catch (error) {
    if (String(error.stderr).includes("E404")) return { id, changed: null };
    throw error;
  }
  const scratchDir = join(scratch, manifest.name.replace("/", "__"));
  const publishedDir = packAndUnpack([id], scratch, join(scratchDir, "published"));
  const localDir = packAndUnpack(["--workspace", dir], ".", join(scratchDir, "local"));
  return { id, changed: changedFiles(publishedDir, localDir) };
}

/** Wheels are not byte-reproducible, so the Python package is compared with the files inside the published sdist. */
async function pythonStatus(version, scratch) {
  const id = `atcn ${version} (PyPI)`;
  const response = await fetch(`https://pypi.org/pypi/atcn/${version}/json`);
  if (response.status === 404) return { id, changed: null };
  if (!response.ok) throw new Error(`PyPI answered ${response.status} for atcn ${version}`);
  const sdist = (await response.json()).urls.find((file) => file.packagetype === "sdist");
  const tarball = join(scratch, sdist.filename);
  writeFileSync(tarball, Buffer.from(await (await fetch(sdist.url)).arrayBuffer()));
  execFileSync("tar", ["-xzf", tarball, "-C", scratch]);
  const isReleasedFile = (name) => PYTHON_TOP_LEVEL_FILES.includes(name) || (name.startsWith("src/atcn/") && name.endsWith(".py"));
  return { id, changed: changedFiles(join(scratch, `atcn-${version}`), PYTHON_DIR, isReleasedFile) };
}

function nextPatch(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

async function plan(strict) {
  const version = check();
  const scratch = mkdtempSync(join(tmpdir(), "atcn-release-"));
  const statuses = [];
  try {
    for (const workspace of workspaces) statuses.push(npmStatus(workspace, scratch));
    statuses.push(await pythonStatus(version, scratch));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  for (const { id, changed } of statuses) {
    if (changed === null) console.log(`${id}: not published yet`);
    else if (changed.length === 0) console.log(`${id}: published, unchanged`);
    else console.log(`${id}: published, but these files changed: ${changed.join(", ")}`);
  }

  let action = "none";
  let releaseVersion = version;
  if (statuses.some(({ changed }) => changed !== null && changed.length > 0)) {
    action = "bump";
    releaseVersion = nextPatch(version);
  } else if (statuses.some(({ changed }) => changed === null)) {
    action = "publish";
  }
  console.log(`Decision: ${action} ${releaseVersion}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `action=${action}\nversion=${releaseVersion}\n`);

  if (strict && action === "bump") {
    printError(`Packages changed since ${version} was published. Releases bump the version first: npm run set-version -- ${releaseVersion}`);
    process.exit(1);
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "check") check();
else if (command === "set") set(args[0]);
else if (command === "plan") await plan(args.includes("--strict"));
else {
  console.error("usage: node scripts/release.mjs check | set <version> | plan [--strict]");
  process.exit(2);
}
