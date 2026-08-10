// npm run upgrade (or `deno task upgrade`) — refresh THIS app's source from a newer
// published pack of @nanobpm/nano-workforce, WITHOUT touching your data.
//
// Why this exists: a Console project stamped from the example pack is a one-time
// COPY (a snapshot/fork) — there is no built-in "update from template". This
// script performs the Option-A "keep the database" upgrade: it fetches a newer
// pack (via `npm pack`), then overlays its files onto the current directory while
// PRESERVING the sqlite datasource (`app.db` + WAL/SHM sidecars), generated SDK
// (`nano-generated/`), and local VCS/deps (`.git/`, `node_modules/`). Because the
// app's migrations in `db/migrations` are additive and re-applied on boot, your
// existing data survives and any new migrations top it up on the next `npm start`.
//
// SAFETY: dry-run by default. It prints the plan (files it would create/overwrite,
// and anything preserved or newly-orphaned) and writes NOTHING until you pass
// `--apply`. It never deletes files. If you modified the app, review the plan —
// an overlay overwrites your edits to any file the new version also ships.
//
// Usage:
//   npm run upgrade                         # dry-run against @latest
//   npm run upgrade -- --apply              # perform the @latest overlay
//   npm run upgrade -- --version 0.7.0 --apply
//   npm run upgrade -- --from ./pkg --apply # overlay a local dir/tarball (offline)
//
// Flags:
//   --apply             write changes (default: dry-run preview)
//   --version <v>       npm dist-tag or version to fetch (default: "latest")
//   --package <name>    package to fetch (default: "@nanobpm/nano-workforce")
//   --from <path>       use a local extracted dir OR a .tgz tarball as the source
//                       (skips `npm pack`; --version/--package are ignored)
//   --force             overlay even if the cwd doesn't look like this app
//   -h, --help          show this help

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

interface Args {
  apply: boolean;
  version: string;
  pkg: string;
  from: string | null;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    apply: false,
    version: "latest",
    pkg: "@nanobpm/nano-workforce",
    from: null,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--apply":
        a.apply = true;
        break;
      case "--force":
        a.force = true;
        break;
      case "--version":
        a.version = req(argv, ++i, arg);
        break;
      case "--package":
        a.pkg = req(argv, ++i, arg);
        break;
      case "--from":
        a.from = req(argv, ++i, arg);
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg} (try --help)`);
    }
  }
  return a;
}

function req(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return v;
}

function printHelp(): void {
  console.log(
    readFileSync(new URL(import.meta.url), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("// "))
      .map((l) => l.slice(3))
      .join("\n"),
  );
}

/** Resolve a `file:` datasource URL to a filesystem path (mirrors purge-db.ts so
 *  the DB we preserve is exactly the one the runtime opens). Non-`file:` schemes
 *  (e.g. libsql/turso) have no local file to protect, so they return null. */
function datasourcePath(url: string): string | null {
  if (!url.startsWith("file:")) return null;
  const decode = (p: string): string => {
    try {
      return decodeURIComponent(p);
    } catch (e) {
      throw new Error(`could not decode datasource path in URL: ${url}`, { cause: e });
    }
  };
  if (url.startsWith("file://")) {
    const parsed = new URL(url);
    if (parsed.hostname && parsed.hostname !== "localhost") {
      throw new Error(`remote file host unsupported in datasource URL: ${url}`);
    }
    const p = decode(parsed.pathname);
    return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
  }
  const p = decode(url.slice("file:".length));
  return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
}

/** Recursively list files (not directories) under `root`, as paths relative to it.
 *  `skipTop` names top-level directories to skip entirely (e.g. node_modules, .git)
 *  so we never walk large machine-local trees. */
function listFiles(root: string, skipTop: Set<string> = new Set()): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && entry.isDirectory() && skipTop.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(relative(root, abs));
    }
  };
  walk(root);
  return out;
}

/** True when `rel` is inside one of the preserved top-level directories, or is a
 *  preserved DB file/sidecar. */
function isPreserved(rel: string, preservedDirs: Set<string>, preservedFiles: Set<string>): boolean {
  if (preservedFiles.has(rel)) return true;
  const top = rel.split(sep)[0];
  return preservedDirs.has(top);
}

/** Fetch the package with `npm pack` into a temp dir and extract it, returning the
 *  path to the extracted `package/` directory. */
function fetchPack(pkg: string, version: string, tmp: string): string {
  const spec = `${pkg}@${version}`;
  console.log(`• fetching ${spec} via npm pack …`);
  const out = execFileSync("npm", ["pack", spec, "--pack-destination", tmp, "--silent"], {
    encoding: "utf8",
  }).trim();
  // `npm pack --silent` prints the tarball filename (last line, to be safe).
  const tgz = out.split("\n").filter(Boolean).pop();
  if (!tgz) throw new Error(`npm pack produced no tarball for ${spec}`);
  return extractTarball(join(tmp, tgz), tmp);
}

/** Extract a .tgz into `tmp` and return the `package/` dir npm tarballs wrap. */
function extractTarball(tgz: string, tmp: string): string {
  if (!existsSync(tgz)) throw new Error(`tarball not found: ${tgz}`);
  // Validate the archive listing BEFORE extracting: an untrusted `.tgz` may carry
  // absolute paths or `../` segments that would let `tar` write outside `tmp`.
  // Fail fast on any unsafe entry instead of trusting `tar` to sandbox itself.
  const listing = runTar(["-tzf", tgz], tgz);
  for (const raw of listing.split("\n")) {
    const entry = raw.trim();
    if (!entry) continue;
    if (isAbsolute(entry) || /^[A-Za-z]:[\\/]/.test(entry)) {
      throw new Error(`refusing to extract tarball with absolute path entry: ${entry} (${tgz})`);
    }
    const parts = entry.split(/[\\/]/);
    if (parts.includes("..")) {
      throw new Error(`refusing to extract tarball with '..' path segment: ${entry} (${tgz})`);
    }
  }
  runTar(["-xzf", tgz, "-C", tmp], tgz);
  const pkgDir = join(tmp, "package");
  if (!existsSync(pkgDir)) throw new Error(`extracted tarball has no package/ dir: ${tgz}`);
  return pkgDir;
}

/** Run `tar` with a clearer error when it is missing or fails. */
function runTar(tarArgs: string[], tgz: string): string {
  try {
    return execFileSync("tar", tarArgs, { encoding: "utf8" });
  } catch (e) {
    // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`'tar' not found on PATH — install it to extract ${tgz}`, { cause: e });
    }
    // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
    throw new Error(`tar failed on ${tgz}: ${(e as Error).message}`, { cause: e });
  }
}

/** Resolve the source dir from --from (a dir or a .tgz) or from npm. */
function resolveSource(args: Args, tmp: string): string {
  if (args.from) {
    const p = resolve(args.from);
    if (!existsSync(p)) throw new Error(`--from path does not exist: ${p}`);
    if (statSync(p).isDirectory()) {
      // Accept either the app dir itself or an npm-style `package/` wrapper.
      const wrapped = join(p, "package");
      return existsSync(join(wrapped, "nano.app.json")) ? wrapped : p;
    }
    return extractTarball(p, tmp);
  }
  return fetchPack(args.pkg, args.version, tmp);
}

function packageVersion(dir: string): string {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version ?? "?";
  } catch {
    return "?";
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  if (!existsSync(join(cwd, "nano.app.json")) && !args.force) {
    throw new Error(
      "current directory has no nano.app.json — run this from the app/project root " +
        "(or pass --force if you're sure)",
    );
  }

  // Preserve the live datasource (+ WAL/SHM sidecars) and machine-local dirs.
  const dbUrl = process.env.NANO_APP_DB_URL ?? "file:./app.db";
  const dbPath = datasourcePath(dbUrl);
  const preservedFiles = new Set<string>();
  if (dbPath) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const rel = relative(cwd, resolve(cwd, dbPath + suffix));
      // Only protect DB files that live inside the project: a relative path with
      // no leading `..` and not absolute. On Windows `path.relative()` returns an
      // absolute path (e.g. `C:\…`) when cwd and the DB are on different drives —
      // that is out-of-tree, so an overlay never touches it.
      if (!rel.startsWith("..") && !isAbsolute(rel)) preservedFiles.add(rel);
    }
  }
  const preservedDirs = new Set(["nano-generated", ".nano", ".git", "node_modules"]);

  const tmp = mkdtempSync(join(tmpdir(), "upr-upgrade-"));
  try {
    const src = resolveSource(args, tmp);
    const srcVersion = packageVersion(src);
    const curVersion = packageVersion(cwd);
    // Describe the source accurately: with --from we overlay a local path and never
    // consult npm, so naming args.pkg (the npm default) would be misleading.
    const srcLabel = args.from ? `${args.from} (local)` : args.pkg;
    console.log(`• source ${srcLabel} @ ${srcVersion}  →  current @ ${curVersion}\n`);

    const srcFiles = listFiles(src);
    const created: string[] = [];
    const overwritten: string[] = [];
    const skipped: string[] = [];
    for (const rel of srcFiles) {
      if (isPreserved(rel, preservedDirs, preservedFiles)) {
        skipped.push(rel);
        continue;
      }
      (existsSync(join(cwd, rel)) ? overwritten : created).push(rel);
    }

    // Files present locally but not shipped by the new version (informational —
    // never deleted; may be your data, or something the new version dropped).
    const srcSet = new Set(srcFiles);
    const orphans = listFiles(cwd, preservedDirs)
      .filter((rel) => !isPreserved(rel, preservedDirs, preservedFiles))
      .filter((rel) => !srcSet.has(rel));

    report("create", created);
    report("overwrite", overwritten);
    if (skipped.length) console.log(`  preserved (not overlaid): ${skipped.length} file(s)`);
    if (preservedFiles.size) {
      console.log(`  keeping database: ${[...preservedFiles].join(", ")}`);
    }
    report("orphan (kept, review)", orphans);

    if (!args.apply) {
      console.log(
        `\nDRY RUN — nothing written. Re-run with --apply to overlay ` +
          `${created.length + overwritten.length} file(s).`,
      );
      return;
    }

    for (const rel of [...created, ...overwritten]) {
      const dest = join(cwd, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(src, rel), dest, { recursive: false });
    }
    // Guard against a script that overwrote itself mid-run on some platforms: the
    // copy is byte-for-byte, so this is just a friendly confirmation.
    console.log(
      `\n✔ overlaid ${created.length + overwritten.length} file(s) → now @ ${srcVersion}.\n` +
        `Next: reinstall deps if package.json changed, then restart the app —\n` +
        `the runtime re-applies db/migrations on boot, preserving your data.`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function report(label: string, files: string[]): void {
  if (!files.length) return;
  console.log(`  ${label}: ${files.length} file(s)`);
  const show = files.slice(0, 20);
  for (const f of show) console.log(`    ${f}`);
  if (files.length > show.length) console.log(`    … and ${files.length - show.length} more`);
}

try {
  main();
} catch (err) {
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  console.error(`upgrade failed: ${(err as Error).message}`);
  process.exit(1);
}
