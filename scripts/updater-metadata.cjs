#!/usr/bin/env node

// Rebuilds the Tauri updater manifest (`latest.json`) for a published GitHub release.
//
// GitHub Actions builds every desktop target in its own matrix job, and
// tauri-action can only publish the platform entries for the target it built.
// Every job also overwrites `latest.json`, so whichever job finishes last wins.
// This script keeps the platform entries that are already published and fills in
// the missing ones from the updater signatures uploaded next to the installers,
// so macOS Apple Silicon, macOS Intel, and Windows x64 all stay updatable.

const fs = require("node:fs");
const path = require("node:path");

const PUBLIC_REPO_URL = "https://github.com/wanghuan9/skilldock";
const SIGNATURE_SUFFIX = ".sig";

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      fail(`unexpected argument: ${token}`);
    }

    const name = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`missing value for --${name}`);
    }

    options[name] = value;
    index += 1;
  }

  return options;
}

function readTextFile(filePath, { optional = false } = {}) {
  if (!fs.existsSync(filePath)) {
    if (optional) {
      return null;
    }
    fail(`file not found: ${filePath}`);
  }

  return fs.readFileSync(filePath, "utf8");
}

function readJsonFile(filePath) {
  const content = readTextFile(filePath, { optional: true });
  if (content === null || content.trim() === "") {
    return null;
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    fail(`invalid JSON in ${filePath}: ${error.message}`);
  }

  return null;
}

// macOS updater archives are uploaded as `SkillDock_<arch>.app.tar.gz`.
function macPlatformEntry(fileName, releaseBaseUrl) {
  const match = /^SkillDock_(.+)\.app\.tar\.gz$/.exec(fileName);
  if (!match) {
    return null;
  }

  const arch = match[1];
  return {
    primaryKey: `darwin-${arch}`,
    // Tauri v1 looked up the `<target>-app` key; keep both so older installs update too.
    compatKey: `darwin-${arch}-app`,
    url: `${releaseBaseUrl}/${fileName}`,
  };
}

// Windows NSIS installers are uploaded as `SkillDock_<version>_x64-setup.exe`.
function windowsPlatformEntry(fileName, releaseBaseUrl) {
  const match = /^SkillDock_.+_x64-setup\.exe$/.exec(fileName);
  if (!match) {
    return null;
  }

  return {
    primaryKey: "windows-x86_64",
    compatKey: null,
    url: `${releaseBaseUrl}/${fileName}`,
  };
}

function collectSignatureFiles(signatureDir) {
  if (!fs.existsSync(signatureDir)) {
    return [];
  }

  return fs
    .readdirSync(signatureDir)
    .filter((fileName) => fileName.endsWith(SIGNATURE_SUFFIX))
    .sort();
}

function readSignature(signatureDir, signatureFile) {
  const content = readTextFile(path.join(signatureDir, signatureFile));
  return content.trim();
}

function resolvePlatformEntry(signatureFile, releaseBaseUrl) {
  const installerName = signatureFile.slice(0, -SIGNATURE_SUFFIX.length);
  return macPlatformEntry(installerName, releaseBaseUrl)
    || windowsPlatformEntry(installerName, releaseBaseUrl);
}

function buildPlatforms({ signatureDir, releaseBaseUrl, existingPlatforms }) {
  const platforms = { ...existingPlatforms };
  const added = [];
  const skipped = [];

  for (const signatureFile of collectSignatureFiles(signatureDir)) {
    const entry = resolvePlatformEntry(signatureFile, releaseBaseUrl);
    if (!entry) {
      skipped.push(signatureFile);
      continue;
    }

    const signature = readSignature(signatureDir, signatureFile);
    if (!signature) {
      fail(`updater signature is empty: ${signatureFile}`);
    }

    const platform = { signature, url: entry.url };
    for (const key of [entry.primaryKey, entry.compatKey].filter(Boolean)) {
      if (!platforms[key]) {
        platforms[key] = platform;
        added.push(key);
      }
    }
  }

  if (skipped.length > 0) {
    process.stdout.write(`Ignored unrecognized updater assets: ${skipped.join(", ")}\n`);
  }

  return { platforms, added };
}

function resolveReleaseNotes({ existingManifest, notesText, version, pubDate }) {
  const notes = (notesText ?? existingManifest?.notes ?? "").replace(/\n+$/, "");
  const history = existingManifest?.releaseNotesHistory;

  if (Array.isArray(history) && history.length > 0) {
    return { notes, releaseNotesHistory: history };
  }

  return { notes, releaseNotesHistory: [{ version, notes, pub_date: pubDate }] };
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  for (const name of ["tag", "version", "signature-dir", "output"]) {
    if (!options[name]) {
      fail(`missing required option --${name}`);
    }
  }

  const existingManifest = readJsonFile(options["latest-json"]);
  const releaseBaseUrl = `${PUBLIC_REPO_URL}/releases/download/${options.tag}`;
  const pubDate = new Date().toISOString();
  const { platforms, added } = buildPlatforms({
    signatureDir: options["signature-dir"],
    releaseBaseUrl,
    existingPlatforms: existingManifest?.platforms ?? {},
  });

  const signatureCount = collectSignatureFiles(options["signature-dir"]).length;
  if (signatureCount === 0) {
    process.stdout.write(`No updater signatures found in ${options["signature-dir"]}; leaving latest.json unchanged.\n`);
    return;
  }

  if (Object.keys(platforms).length === 0) {
    fail("no updater platform entries could be resolved; refusing to overwrite latest.json");
  }

  const { notes, releaseNotesHistory } = resolveReleaseNotes({
    existingManifest,
    notesText: readTextFile(options.notes, { optional: true }),
    version: options.version,
    pubDate,
  });

  const manifest = {
    version: options.version,
    notes,
    pub_date: pubDate,
    platforms,
    releaseNotesHistory,
  };

  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(`Updater platform entries added: ${added.length > 0 ? added.join(", ") : "none"}\n`);
  for (const [key, value] of Object.entries(platforms)) {
    process.stdout.write(`  ${key} -> ${value.url}\n`);
  }
  process.stdout.write(`Wrote ${options.output}\n`);
}

main();
