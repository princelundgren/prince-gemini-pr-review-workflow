// @ts-check
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { parseDiff, placeFindings, readAnswer } from "./contract.mjs";

/** @typedef {import("./contract.mjs").Finding} Finding */
/** @typedef {import("./contract.mjs").Answer} Answer */

const MAX_BODY_CHARACTERS = 65536;
const MAX_RAW_CHARACTERS = 4000;
const REQUEST_TIMEOUT_MS = 30_000;
const CUT_NOTICE = "\n\n_This review was cut to fit GitHub's size limit._";

const GEMINI_EXIT_MEANINGS = new Map([
  [1, "runtime or API failure"],
  [2, "invalid usage"],
  [3, "authentication failure"],
]);

/** @param {number} status the non-zero exit status of the gemini-api call */
const geminiFailure = (status) => {
  const meaning = GEMINI_EXIT_MEANINGS.get(status);
  return `The gemini-api call failed with exit status ${status}${meaning ? ` (${meaning})` : ""}; the job log has the error.`;
};

/** @param {string} sha */
const heading = (sha) => `## Gemini review of ${sha}`;

/**
 * Model text with a zero-width space after every `@`, after the `#` of a number, after the `-` of
 * `GH-` and a number, and after the `&` of a character reference (`&#64;`, `&commat;`, `&num;`), so
 * neither the text nor what a Markdown renderer decodes from it can mention a user or team, or link
 * an issue or pull request, as the bot. The space goes after `#`: GitHub still links `\u200b#12`.
 * @param {string} text
 */
const neutralise = (text) =>
  text
    .replace(/&(?=#|commat;|num;)/g, "&\u200b")
    .replaceAll("@", "@\u200b")
    .replace(/#(?=\d)/g, "#\u200b")
    .replace(/GH-(?=\d)/gi, "$&\u200b");

/**
 * @param {string} text
 * @returns {number} the length of the longest run of backticks in `text`, 0 when there is none
 */
function longestBacktickRun(text) {
  let longest = 0;
  for (const [run] of text.matchAll(/`+/g)) longest = Math.max(longest, run.length);
  return longest;
}

/** @param {string} text */
const onOneLine = (text) => text.replace(/\s*[\r\n]+\s*/g, " ");

/**
 * `text` as one inline code span on one line: a delimiter longer than any backtick run in it, padded
 * with spaces when it holds a backtick, as CommonMark requires.
 * @param {string} text
 */
function codeSpan(text) {
  const oneLine = onOneLine(text);
  const longestRun = longestBacktickRun(oneLine);
  const delimiter = "`".repeat(longestRun + 1);
  return longestRun > 0 ? `${delimiter} ${oneLine} ${delimiter}` : `${delimiter}${oneLine}${delimiter}`;
}

/** @param {Finding} finding */
const bodyLine = (finding) =>
  `${codeSpan(`${finding.path}:${finding.line}`)} — ${finding.severity} ${onOneLine(finding.body)}`;

/**
 * @param {string} title
 * @param {string} summary
 * @param {Finding[]} findings
 */
function section(title, summary, findings) {
  const parts = [summary.trim(), ...findings.map(bodyLine)].filter((part) => part !== "");
  return `**${title}**\n${parts.length > 0 ? parts.join("\n") : "None."}`;
}

/**
 * The review's body: the four Output Format sections, findings that could not be inline comments, and what Gemini did not see.
 * Neutralised as a whole, since how a finding's path pairs up with the text around it is decided by the whole
 * text, then cut to GitHub's 65,536-character limit.
 * @param {{ sha: string, answer: Answer, inBody: Finding[], dropped: string[], diffCut: boolean }} input
 * @returns {string}
 */
export function reviewBody({ sha, answer, inBody, dropped, diffCut }) {
  const { summary } = answer;
  const bySeverity = (/** @type {string} */ severity) => inBody.filter((finding) => finding.severity === severity);
  const blocks = [
    heading(sha),
    section("🔴 Critical Issues", summary.critical, bySeverity("🔴")),
    section("🟡 Suggestions", summary.suggestions, bySeverity("🟡")),
    section("🔵 Nits", summary.nits, bySeverity("🔵")),
    section("✅ Checked", summary.checked, []),
  ];
  const notSeen = [...dropped.map((entry) => `- ${entry}`), ...(diffCut ? ["- The diff was cut to fit the size limit."] : [])];
  if (notSeen.length > 0) blocks.push(`**Not seen**\n${notSeen.join("\n")}`);

  const body = neutralise(blocks.join("\n\n"));
  if (body.length <= MAX_BODY_CHARACTERS) return body;
  let end = MAX_BODY_CHARACTERS - CUT_NOTICE.length;
  const last = body.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return body.slice(0, end) + CUT_NOTICE;
}

/**
 * The body posted when no review could be: what failed, then the model's raw text capped at 4,000 characters.
 * @param {string} sha
 * @param {string} reason
 * @param {string} raw
 * @returns {string}
 */
export function failureBody(sha, reason, raw) {
  const lines = [heading(sha), "", reason];
  if (raw !== "") {
    const longestRun = longestBacktickRun(raw);
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    let end = MAX_RAW_CHARACTERS;
    const last = raw.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    lines.push("", fence, raw.slice(0, end), fence);
  }
  return neutralise(lines.join("\n"));
}

/** @param {any} value @returns {value is { dropped: string[], diffCut: boolean }} */
const isPackReport = (value) =>
  value !== null &&
  typeof value === "object" &&
  Array.isArray(value.dropped) &&
  value.dropped.every((/** @type {unknown} */ entry) => typeof entry === "string") &&
  typeof value.diffCut === "boolean";

/** @param {string} path */
async function readIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return "";
    throw error;
  }
}

/**
 * Posts Gemini's answer as one COMMENT review. Never throws and never logs the model's text.
 * `earlierFailure`, when set, names the step that kept Gemini from being asked, and is posted as the failure instead.
 * `geminiExitStatus`, when set and not 0, is the exit status of the failed gemini-api call; the notice names it
 * and leaves the error itself to the job log, where secrets are masked.
 * @param {{ repo: string, pr: number, sha: string, responseFile: string, diffFile: string, packReport: string, token: string, earlierFailure?: string, geminiExitStatus?: number, fetch?: typeof fetch }} input
 * @returns {Promise<void>}
 */
export async function post({ repo, pr, sha, responseFile, diffFile, packReport, token, earlierFailure, geminiExitStatus, fetch: fetchImpl = fetch }) {
  /** @param {{ body: string, comments: object[], commit_id?: string }} review @returns {Promise<number>} the HTTP status, 0 when the request never got one */
  async function submit(review) {
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${repo}/pulls/${pr}/reviews`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ event: "COMMENT", ...review }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return response.status;
    } catch {
      return 0;
    }
  }

  // No commit_id: GitHub refuses one whose commit is gone after a force-push, and the notice must still land.
  /** @param {string} reason @param {string} raw */
  async function postFailure(reason, raw) {
    const status = await submit({ body: failureBody(sha, reason, raw), comments: [] });
    console.log(`Posted the failure notice (HTTP ${status}).`);
    if (status < 200 || status >= 300) console.log(`::warning::Could not post the failure notice (HTTP ${status}).`);
  }

  if (earlierFailure) return postFailure(earlierFailure, "");
  if (geminiExitStatus) return postFailure(geminiFailure(geminiExitStatus), "");
  /** @type {string} */
  let raw;
  try {
    raw = (await readIfPresent(responseFile)).trim();
  } catch {
    return postFailure("The answer file could not be read.", "");
  }
  if (raw === "") return postFailure("Gemini gave no answer.", "");
  const read = readAnswer(raw);
  if (!read.ok) return postFailure(`Gemini's answer could not be read: ${read.reason}.`, raw);

  /** @type {{ dropped: string[], diffCut: boolean }} */
  let report;
  // Not posting the findings without the pack report: its "Not seen" list shows what Gemini did not see.
  try {
    report = JSON.parse(await readFile(packReport, "utf8"));
    if (!isPackReport(report)) throw new Error("wrong shape");
  } catch {
    return postFailure("The pack report could not be read.", "");
  }
  const { dropped, diffCut } = report;
  /** @type {string} */
  let diff;
  try {
    diff = await readFile(diffFile, "utf8");
  } catch {
    return postFailure("The diff could not be read.", "");
  }
  const { answer } = read;
  const { inline, inBody } = placeFindings(answer.findings, parseDiff(diff));
  const comments = inline.map(({ path, line, side, severity, body }) => ({ path, line, side, body: neutralise(`${severity} ${body}`) }));

  const status = await submit({ commit_id: sha, body: reviewBody({ sha, answer, inBody, dropped, diffCut }), comments });
  if (status >= 200 && status < 300) return console.log(`Posted the review (HTTP ${status}).`);
  if (status === 422 && comments.length > 0) {
    const retried = await submit({ commit_id: sha, body: reviewBody({ sha, answer, inBody: answer.findings, dropped, diffCut }), comments: [] });
    console.log(`Retried without inline comments (HTTP ${retried}).`);
    if (retried >= 200 && retried < 300) return;
    return postFailure(`Posting the review failed (HTTP ${retried}).`, "");
  }
  return postFailure(`Posting the review failed (HTTP ${status}).`, "");
}

/**
 * The arguments of `post`, read from the variables `action.yml` sets. Throws `<NAME> is not set` for a missing
 * required one; an empty or non-numeric `GEMINI_EXIT_STATUS` is left unset.
 * @param {Record<string, string | undefined>} env
 */
export function readEnv(env) {
  const [repo, pr, sha, responseFile, diffFile, packReport, token] = [
    "REPO", "PR", "SHA", "RESPONSE_FILE", "DIFF_FILE", "PACK_REPORT", "GITHUB_TOKEN",
  ].map((name) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  });
  const geminiExitStatus = Number.parseInt(env.GEMINI_EXIT_STATUS ?? "", 10);
  return {
    repo, pr: Number(pr), sha, responseFile, diffFile, packReport, token,
    earlierFailure: env.EARLIER_FAILURE,
    geminiExitStatus: Number.isNaN(geminiExitStatus) ? undefined : geminiExitStatus,
  };
}

async function main() {
  await post(readEnv(process.env));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(`::warning::${error instanceof Error ? error.message : String(error)}`);
  });
}
