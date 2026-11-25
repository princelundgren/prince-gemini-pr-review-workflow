// @ts-check
import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {{ title: string, body: string, commits: string, diff: string }} PullRequestText */
/**
 * @typedef {object} PackArguments
 * @property {string} checkout the PR's merge commit, untrusted
 * @property {string} outFile
 * @property {PullRequestText} pr
 * @property {string[]} changedPaths relative to the checkout
 * @property {string[]} earlierReviews
 * @property {string} [extraDir] outside the checkout
 * @property {string} skillDir outside the checkout
 * @property {number} limitBytes size of the document in UTF-8 bytes; exceeded only when the pull
 *   request text and an empty diff part alone are over it, since both always go in
 */
/** @typedef {{ included: string[], dropped: string[], diffCut: boolean }} PackReport */
/** @typedef {{ label: string, name: string, text: string }} Part */

const BINARY_SNIFF_BYTES = 8192;
const DIFF_CUT_NOTE = "(The diff was cut at the last whole hunk to fit the size limit.)\n";

const byteLength = (/** @type {string} */ text) => Buffer.byteLength(text);

/**
 * @param {string} text
 * @returns {number} the length of the longest run of backticks in `text`, 0 when there is none
 */
function longestBacktickRun(text) {
  let longest = 0;
  for (const [run] of text.matchAll(/`+/g)) longest = Math.max(longest, run.length);
  return longest;
}

/**
 * @param {string} content
 * @returns {string} a fence longer than any backtick run in `content`
 */
function fenceFor(content) {
  return "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
}

/**
 * @param {string} text
 * @returns {string} `text` with every control, line-separator and bidirectional-control character made
 *   a visible `?`, so a file name can neither start a new line of the document nor reorder its text
 */
const oneLine = (text) => text.replace(/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/gu, "?");

/**
 * @param {string} label
 * @param {string} content
 * @param {string} [info] fence info string
 */
function fencedPart(label, content, info = "") {
  const fence = fenceFor(content);
  const body = content.endsWith("\n") || content === "" ? content : `${content}\n`;
  return `=== ${label} ===\n${fence}${info}\n${body}${fence}\n\n`;
}

/**
 * Throws unless `path` stays inside `root` and no component of it is a symlink.
 * @param {string} root real path of the root
 * @param {string} path relative to `root`
 * @param {string} display how the path is named in an error
 * @returns {Promise<import("node:fs").Stats | undefined>} the file's stats, or undefined when it does not
 *   exist, or when a parent of it is a regular file
 */
async function checkInside(root, path, display) {
  const target = resolve(root, path);
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`outside the checkout: ${display}`);
  }
  let current = root;
  let stats;
  for (const component of fromRoot.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      stats = await lstat(current);
    } catch (error) {
      const { code } = /** @type {NodeJS.ErrnoException} */ (error);
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(`refusing symlink: ${display}`);
  }
  const real = await realpath(target);
  const realFromRoot = relative(root, real);
  if (realFromRoot === ".." || realFromRoot.startsWith(`..${sep}`) || isAbsolute(realFromRoot)) {
    throw new Error(`outside the checkout: ${display}`);
  }
  return stats ?? (await lstat(root));
}

/**
 * Every regular file under `dir`, sorted, as paths relative to it. A symlink anywhere is refused.
 * @param {string} dir
 * @returns {Promise<string[]>} empty when `dir` does not exist, which `pack` allows for `extraDir` only
 */
async function listFiles(dir) {
  let stats;
  try {
    stats = await lstat(dir);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return [];
    throw error;
  }
  if (stats.isSymbolicLink()) throw new Error(`refusing symlink: ${dir}`);
  /** @type {string[]} */
  const files = [];
  /** @param {string} relativeDir */
  async function walk(relativeDir) {
    const entries = await readdir(join(dir, relativeDir), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const entryPath = join(relativeDir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`refusing symlink: ${join(dir, entryPath)}`);
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  await walk("");
  return files;
}

/**
 * @param {string} file
 * @returns {Promise<string | undefined>} the text, or undefined for a binary file: one with a NUL byte
 *   in its first 8,192 bytes, the only part sniffed. Invalid UTF-8 anywhere becomes U+FFFD.
 */
async function readText(file) {
  const bytes = await readFile(file);
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0) ? undefined : bytes.toString("utf8");
}

/**
 * @param {string} diff
 * @param {number} budget bytes the diff part may take
 * @returns {{ part: string, cut: boolean }}
 */
function fitDiff(diff, budget) {
  const whole = fencedPart("diff", diff, "diff");
  if (byteLength(whole) <= budget) return { part: whole, cut: false };
  const lines = diff.split("\n");
  /** @type {number[]} */
  const cutPoints = [0];
  let seenHunk = false;
  lines.forEach((line, index) => {
    if (line.startsWith("diff --git ")) {
      cutPoints.push(index);
      seenHunk = false;
    } else if (line.startsWith("@@")) {
      if (seenHunk) cutPoints.push(index);
      seenHunk = true;
    }
  });
  // Byte size and longest backtick run of the first `point` lines, from running totals.
  const lineBytes = lines.map((line) => byteLength(line));
  const lineRuns = lines.map(longestBacktickRun);
  const framing = byteLength("=== diff ===\n") + byteLength("diff\n") + byteLength(DIFF_CUT_NOTE) + 2;
  /** @type {Map<number, { bytes: number, run: number }>} */
  const prefixes = new Map([[0, { bytes: 0, run: 0 }]]);
  let bytes = 0;
  let run = 0;
  lines.forEach((_, index) => {
    bytes += lineBytes[index] + (index > 0 ? 1 : 0);
    run = Math.max(run, lineRuns[index]);
    prefixes.set(index + 1, { bytes, run });
  });
  /** @param {number} point */
  const sizeAt = (point) => {
    const prefix = /** @type {{ bytes: number, run: number }} */ (prefixes.get(point));
    const needsNewline = point > 0 && lines[point - 1] !== "";
    return framing + 2 * Math.max(3, prefix.run + 1) + prefix.bytes + (needsNewline ? 1 : 0);
  };
  const point = cutPoints.findLast((candidate) => sizeAt(candidate) <= budget) ?? 0;
  return { part: fencedPart("diff", lines.slice(0, point).join("\n"), "diff") + DIFF_CUT_NOTE, cut: true };
}

/**
 * Packs everything Gemini may read about a pull request into one Markdown document.
 * Every part is fenced, so no text of the PR or a file can forge another part's header. Order: PR
 * text, diff, skill, AGENTS.md chain, changed files at head, extra directory, earlier reviews. The PR
 * text and diff always go in; every later part goes in whole if it still fits.
 * @param {PackArguments} args
 * @returns {Promise<PackReport>}
 * @throws on a symlink, a path outside the checkout or a missing `skillDir`
 */
export async function pack({ checkout, outFile, pr, changedPaths, earlierReviews, extraDir, skillDir, limitBytes }) {
  try {
    await lstat(skillDir);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") throw new Error(`skill directory not found: ${skillDir}`);
    throw error;
  }
  const checkoutReal = await realpath(checkout);
  /** @type {Part[]} */
  const candidates = [];
  /** @type {string[]} */
  const dropped = [];

  /** @param {string} name @param {string} label @param {string | undefined} text */
  const consider = (name, label, text) => {
    if (text === undefined) dropped.push(`${oneLine(name)}: binary`);
    else candidates.push({ label: oneLine(label), name: oneLine(name), text });
  };

  /**
   * Adds a file of the pull request's checkout, unread when its size alone is over the limit.
   * @param {string} name @param {string} label @param {number} size @param {string} file
   */
  const considerCheckoutFile = async (name, label, size, file) => {
    if (size > limitBytes) dropped.push(`${oneLine(name)}: over the size limit`);
    else consider(name, label, await readText(file));
  };

  /** @param {string} directory @param {string} prefix */
  const considerDirectory = async (directory, prefix) => {
    for (const file of await listFiles(directory)) {
      consider(`${prefix}: ${file}`, `${prefix}: ${file}`, await readText(join(directory, file)));
    }
  };
  // The skill is small and pinned, so it goes in before the pull request's files can push it out.
  await considerDirectory(skillDir, "skill");

  /** @type {Map<string, import("node:fs").Stats | undefined>} */
  const changedStats = new Map();
  for (const changed of changedPaths) changedStats.set(changed, await checkInside(checkoutReal, changed, changed));

  /** @type {Set<string>} */
  const chain = new Set();
  const changedSet = new Set(changedPaths);
  for (const changed of changedPaths) {
    const directories = dirname(changed) === "." ? [] : dirname(changed).split("/");
    for (let depth = 0; depth <= directories.length; depth += 1) {
      chain.add(join(...directories.slice(0, depth), "AGENTS.md"));
    }
  }
  for (const agents of chain) {
    if (changedSet.has(agents)) continue;
    const stats = await checkInside(checkoutReal, agents, agents);
    if (stats?.isFile()) await considerCheckoutFile(agents, `AGENTS.md: ${agents}`, stats.size, join(checkoutReal, agents));
  }

  /** @type {string[]} */
  const deleted = [];
  for (const [changed, stats] of changedStats) {
    if (stats === undefined) deleted.push(changed);
    else if (stats.isFile()) await considerCheckoutFile(changed, `file: ${changed}`, stats.size, join(checkoutReal, changed));
    else dropped.push(`${oneLine(changed)}: not a regular file`);
  }

  if (extraDir) await considerDirectory(extraDir, "extra");
  earlierReviews.forEach((review, index) => {
    const label = `earlier review ${index + 1}`;
    candidates.push({ label, name: label, text: review });
  });

  const prPart = fencedPart("pull request", `# ${pr.title}\n\n${pr.body}\n\n## Commits\n\n${pr.commits}`);
  const { part: diffPart, cut } = fitDiff(pr.diff, limitBytes - byteLength(prPart));
  const included = ["pull request", "diff"];
  const document = [prPart, diffPart];
  let remaining = limitBytes - byteLength(prPart) - byteLength(diffPart);
  for (const { label, name, text } of candidates) {
    const part = fencedPart(label, text);
    if (byteLength(part) > remaining) {
      dropped.push(`${name}: over the size limit`);
      continue;
    }
    remaining -= byteLength(part);
    document.push(part);
    included.push(label);
  }
  dropped.push(...deleted.map((path) => `${oneLine(path)}: deleted`));

  await writeFile(outFile, document.join(""));
  return { included, dropped, diffCut: cut };
}

async function main() {
  const argsFile = process.argv[2];
  if (!argsFile) throw new Error("usage: node pack.mjs <args-json-file>");
  const { reportFile, ...args } = JSON.parse(await readFile(argsFile, "utf8"));
  await writeFile(reportFile, JSON.stringify(await pack(args)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
