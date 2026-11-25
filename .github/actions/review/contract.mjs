// @ts-check

/** @typedef {"🔴" | "🟡" | "🔵"} Severity */
/** @typedef {{ severity: Severity, path: string, line: number, side: "RIGHT" | "LEFT", body: string }} Finding */
/** @typedef {{ summary: Record<"critical" | "suggestions" | "nits" | "checked", string>, findings: Finding[] }} Answer */
/** @typedef {{ right: Set<number>, left: Set<number> }} CommentableLines */
/** @typedef {Map<string, CommentableLines>} Hunks */

const SEVERITIES = ["🔴", "🟡", "🔵"];
const SUMMARY_KEYS = /** @type {const} */ (["critical", "suggestions", "nits", "checked"]);
const MAX_INLINE_FINDINGS = 50;

const SIMPLE_ESCAPES = /** @type {Record<string, number>} */ ({
  a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, "\\": 92,
});

/**
 * Reads one git C-style quoted string at the start of `text`.
 * @param {string} text starts with a double quote
 * @returns {{ value: string, rest: string }}
 */
function readQuoted(text) {
  const bytes = /** @type {number[]} */ ([]);
  const encoder = new TextEncoder();
  let i = 1;
  while (i < text.length && text[i] !== '"') {
    if (text[i] !== "\\") {
      const character = String.fromCodePoint(/** @type {number} */ (text.codePointAt(i)));
      bytes.push(...encoder.encode(character));
      i += character.length;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 1 + octal[0].length;
    } else {
      bytes.push(SIMPLE_ESCAPES[text[i + 1]] ?? text.charCodeAt(i + 1));
      i += 2;
    }
  }
  return { value: new TextDecoder().decode(new Uint8Array(bytes)), rest: text.slice(i + 1) };
}

/**
 * A path as written after `--- `, `+++ `, `rename to ` or in a `diff --git` header.
 * @param {string} text
 * @returns {string}
 */
function readPath(text) {
  return text.startsWith('"') ? readQuoted(text).value : text.replace(/\t$/, "");
}

/**
 * @param {string} path
 * @param {"a/" | "b/"} prefix
 */
const stripPrefix = (path, prefix) => (path.startsWith(prefix) ? path.slice(prefix.length) : path);

/**
 * `--- a/x` or `+++ b/x`: the path, or null for /dev/null.
 * @param {string} text what follows the three marker characters and a space
 * @param {"a/" | "b/"} prefix
 */
function readMarkedPath(text, prefix) {
  const path = readPath(text);
  return path === "/dev/null" ? null : stripPrefix(path, prefix);
}

/**
 * The path of a `diff --git` header, used only when no ---/+++/rename line names one.
 * @param {string} header what follows `diff --git `
 */
function readHeaderPath(header) {
  if (header.startsWith('"')) {
    return stripPrefix(readQuoted(header).value, "a/");
  }
  const length = (header.length - 5) / 2;
  const path = header.slice(2, 2 + length);
  return Number.isInteger(length) && header === `a/${path} b/${path}` ? path : "";
}

/**
 * Parses `git diff` / `gh pr diff` output into the lines a review comment can anchor to.
 * Files are keyed by new path (a deletion by its old path); a binary file gets empty sets.
 * @param {string} diff
 * @returns {Hunks}
 */
export function parseDiff(diff) {
  /** @type {Hunks} */
  const files = new Map();
  /** @type {{ header: string, oldPath?: string | null, newPath?: string | null, renamedTo?: string } | undefined} */
  let file;
  /** @type {CommentableLines | undefined} */
  let lines;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  const openEntry = () => {
    if (!file) return undefined;
    const path = file.newPath ?? file.renamedTo ?? file.oldPath ?? readHeaderPath(file.header);
    if (!path) return undefined;
    let entry = files.get(path);
    if (!entry) {
      entry = { right: new Set(), left: new Set() };
      files.set(path, entry);
    }
    return entry;
  };

  for (const line of diff.split("\n")) {
    if (oldRemaining > 0 || newRemaining > 0) {
      const marker = line[0] ?? " ";
      if (marker === " ") {
        lines?.left.add(oldLine++);
        lines?.right.add(newLine++);
        oldRemaining--;
        newRemaining--;
        continue;
      }
      if (marker === "-") {
        lines?.left.add(oldLine++);
        oldRemaining--;
        continue;
      }
      if (marker === "+") {
        lines?.right.add(newLine++);
        newRemaining--;
        continue;
      }
      if (marker === "\\") continue;
    }
    if (line.startsWith("diff --git ")) {
      file = { header: line.slice("diff --git ".length) };
      lines = undefined;
    } else if (!file) {
      continue;
    } else if (line.startsWith("--- ")) {
      file.oldPath = readMarkedPath(line.slice(4), "a/");
    } else if (line.startsWith("+++ ")) {
      file.newPath = readMarkedPath(line.slice(4), "b/");
    } else if (line.startsWith("rename to ")) {
      file.renamedTo = readPath(line.slice("rename to ".length));
      lines = openEntry();
    } else if (line.startsWith("Binary files ")) {
      lines = openEntry();
    } else {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        lines = openEntry();
        oldLine = Number(hunk[1]);
        oldRemaining = Number(hunk[2] ?? 1);
        newLine = Number(hunk[3]);
        newRemaining = Number(hunk[4] ?? 1);
      }
    }
  }
  return files;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The JSON text: the whole text, or the single fenced block that is the whole text.
 * @param {string} text
 */
function unwrapFence(text) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n```$/.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

/**
 * @param {unknown} raw
 * @param {number} index
 * @returns {{ finding: Finding } | { reason: string }}
 */
function readFinding(raw, index) {
  const at = `findings[${index}]`;
  if (!isRecord(raw)) return { reason: `${at}: must be an object` };
  const { severity, path, line, side, body } = raw;
  if (typeof severity !== "string" || !SEVERITIES.includes(severity)) {
    return { reason: `${at}.severity: must be one of ${SEVERITIES.join(" ")}` };
  }
  if (typeof path !== "string" || path === "") return { reason: `${at}.path: must be a non-empty string` };
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
    return { reason: `${at}.line: must be a positive integer` };
  }
  if (side !== "RIGHT" && side !== "LEFT") return { reason: `${at}.side: must be RIGHT or LEFT` };
  if (typeof body !== "string" || body === "") return { reason: `${at}.body: must be a non-empty string` };
  return { finding: { severity: /** @type {Severity} */ (severity), path, line, side, body } };
}

/**
 * Validates the model's answer text against the JSON contract. Unknown keys are dropped.
 * @param {string} text
 * @returns {{ ok: true, answer: Answer } | { ok: false, reason: string }}
 */
export function readAnswer(text) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(unwrapFence(text));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `answer: not JSON, or not only JSON (${detail})` };
  }
  if (!isRecord(raw)) return { ok: false, reason: "answer: must be a JSON object" };
  if (!isRecord(raw.summary)) return { ok: false, reason: "summary: must be an object" };

  const summary = /** @type {Answer["summary"]} */ ({});
  for (const key of SUMMARY_KEYS) {
    const value = raw.summary[key];
    if (typeof value !== "string") return { ok: false, reason: `summary.${key}: must be a string` };
    summary[key] = value;
  }

  if (!Array.isArray(raw.findings)) return { ok: false, reason: "findings: must be an array" };
  /** @type {Finding[]} */
  const findings = [];
  for (const [index, entry] of raw.findings.entries()) {
    const result = readFinding(entry, index);
    if ("reason" in result) return { ok: false, reason: result.reason };
    findings.push(result.finding);
  }
  return { ok: true, answer: { summary, findings } };
}

/**
 * Splits findings into those that can be inline review comments and those that go in the review body.
 * @param {Finding[]} findings
 * @param {Hunks} hunks
 * @returns {{ inline: Finding[], inBody: Finding[] }}
 */
export function placeFindings(findings, hunks) {
  /** @type {Finding[]} */
  const inline = [];
  /** @type {Finding[]} */
  const inBody = [];
  for (const finding of findings) {
    const changed = hunks.get(finding.path);
    const lines = finding.side === "RIGHT" ? changed?.right : changed?.left;
    if (lines?.has(finding.line) && inline.length < MAX_INLINE_FINDINGS) {
      inline.push(finding);
    } else {
      inBody.push(finding);
    }
  }
  return { inline, inBody };
}
