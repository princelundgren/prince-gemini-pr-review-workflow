import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { failureBody, post, reviewBody } from "../.github/actions/review/post.mjs";

const sha = "abc1234def";
const diff = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,2 @@\n x\n+y\n";
const summary = { critical: "", suggestions: "Consider a rename.", nits: "", checked: "Read a.txt." };
/** @type {import("../.github/actions/review/contract.mjs").Finding} */
const inlineFinding = { severity: "🟡", path: "a.txt", line: 2, side: "RIGHT", body: "Rename y." };
/** @type {import("../.github/actions/review/contract.mjs").Finding} */
const outsideFinding = { severity: "🔴", path: "other.txt", line: 9, side: "RIGHT", body: "Unchecked input." };

/** @type {string} */ let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "post-test-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** @param {string | undefined} responseText */
async function files(responseText, report = { included: [], dropped: [], diffCut: false }) {
  const responseFile = join(dir, "response.txt");
  const diffFile = join(dir, "pr.diff");
  const packReport = join(dir, "report.json");
  if (responseText !== undefined) await writeFile(responseFile, responseText);
  await writeFile(diffFile, diff);
  await writeFile(packReport, JSON.stringify(report));
  return { responseFile, diffFile, packReport };
}

/** @param {number[]} statuses one HTTP status per call, the last repeating */
function stubFetch(statuses) {
  /** @type {{ url: string, init: RequestInit, payload: any }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const stub = async (url, init) => {
    const call = { url: String(url), init: init ?? {}, payload: JSON.parse(String(init?.body)) };
    calls.push(call);
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)] ?? 200;
    return new Response("{}", { status });
  };
  return { stub, calls };
}

const answerText = (/** @type {object[]} */ findings) => JSON.stringify({ summary, findings });
const args = { repo: "o/r", pr: 7, sha, token: "tkn" };

test("post sends one COMMENT review on the head commit with only the placed fields in comments", async () => {
  const { stub, calls } = stubFetch([200]);
  await post({ ...args, ...(await files(answerText([inlineFinding, outsideFinding]))), fetch: stub });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/o/r/pulls/7/reviews");
  assert.equal(calls[0].init.method, "POST");
  const headers = /** @type {Record<string, string>} */ (calls[0].init.headers);
  assert.equal(headers.Authorization, "Bearer tkn");
  assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
  const { payload } = calls[0];
  assert.equal(payload.event, "COMMENT");
  assert.equal(payload.commit_id, sha);
  assert.deepEqual(payload.comments, [{ path: "a.txt", line: 2, side: "RIGHT", body: "🟡 Rename y." }]);
  assert.match(payload.body, /`other\.txt:9` — 🔴 Unchecked input\./);
});

test("post retries a 422 once with every finding in the body and no inline comments", async () => {
  const { stub, calls } = stubFetch([422, 200]);
  await post({ ...args, ...(await files(answerText([inlineFinding]))), fetch: stub });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].payload.comments, []);
  assert.match(calls[1].payload.body, /`a\.txt:2` — 🟡 Rename y\./);
});

test("post posts a failure notice instead of retrying when a 422 has no inline comments", async () => {
  const { stub, calls } = stubFetch([422, 200]);
  await post({ ...args, ...(await files(answerText([outsideFinding]))), fetch: stub });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].payload.comments, []);
  assert.match(calls[0].payload.body, /Unchecked input/);
  assert.match(calls[1].payload.body, /Posting the review failed \(HTTP 422\)\./);
  assert.doesNotMatch(calls[1].payload.body, /Unchecked input/);
});

test("post posts a failure body with the raw text capped at 4000 for an invalid answer", async () => {
  const { stub, calls } = stubFetch([200]);
  await post({ ...args, ...(await files("x".repeat(5000))), fetch: stub });

  assert.equal(calls.length, 1);
  const { body, comments } = calls[0].payload;
  assert.equal(calls[0].payload.event, "COMMENT");
  assert.deepEqual(comments, []);
  assert.match(body, /^## Gemini review of abc1234def/);
  assert.match(body, /x{4000}\n`{3}/);
  assert.doesNotMatch(body, /x{4001}/);
  assert.match(body, /\n\nGemini's answer could not be read: .+\n/);
});

test("a failure notice has no commit_id, so it lands even when the reviewed commit is gone; the review and its retry keep it", async () => {
  const failure = stubFetch([200]);
  await post({ ...args, ...(await files("not json")), fetch: failure.stub });
  assert.ok(!("commit_id" in failure.calls[0].payload));
  assert.match(failure.calls[0].payload.body, /^## Gemini review of abc1234def\n/);

  const review = stubFetch([422, 200]);
  await post({ ...args, ...(await files(answerText([inlineFinding]))), fetch: review.stub });
  assert.equal(review.calls.length, 2);
  for (const call of review.calls) assert.equal(call.payload.commit_id, sha);
});

test("post reports a missing response file as no answer", async () => {
  const { stub, calls } = stubFetch([200]);
  await post({ ...args, ...(await files(undefined)), fetch: stub });
  assert.match(calls[0].payload.body, /Gemini gave no answer\./);
});

test("post posts a failure notice when the response file cannot be read", async () => {
  const { stub, calls } = stubFetch([200]);
  const paths = await files(undefined);
  await mkdir(paths.responseFile);
  await post({ ...args, ...paths, fetch: stub });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].payload.body.endsWith("\n\nThe answer file could not be read."), calls[0].payload.body);
});

test("post reports an empty response file as no answer", async () => {
  const { stub, calls } = stubFetch([200]);
  await post({ ...args, ...(await files("  \n")), fetch: stub });
  assert.match(calls[0].payload.body, /Gemini gave no answer\./);
});

test("post posts a failure body when the review itself is refused with another status", async () => {
  const { stub, calls } = stubFetch([500, 200]);
  await post({ ...args, ...(await files(answerText([]))), fetch: stub });
  assert.equal(calls.length, 2);
  assert.match(calls[1].payload.body, /Posting the review failed \(HTTP 500\)\./);
});

test("post gives every request the signal of a 30 second AbortSignal.timeout", async (t) => {
  const timeout = t.mock.method(AbortSignal, "timeout");
  const { stub, calls } = stubFetch([500, 200]);
  await post({ ...args, ...(await files(answerText([]))), fetch: stub });
  assert.equal(calls.length, 2);
  assert.equal(timeout.mock.callCount(), 2);
  calls.forEach((call, index) => {
    assert.deepEqual(timeout.mock.calls[index].arguments, [30_000]);
    assert.equal(call.init.signal, timeout.mock.calls[index].result);
  });
});

test("post does not throw when every request fails", async () => {
  /** @type {typeof fetch} */
  const broken = async () => {
    throw new Error("offline");
  };
  await post({ ...args, ...(await files(answerText([]))), fetch: broken });
});

const Z = "\u200b";

test("post neutralises mentions and issue references in every piece of model text it posts", async () => {
  const { stub, calls } = stubFetch([200]);
  const text = "cc @octocat, see #12 and o/r#13";
  const answer = {
    summary: { critical: text, suggestions: "", nits: "", checked: "" },
    findings: [{ ...inlineFinding, body: text }, { ...outsideFinding, body: text }],
  };
  await post({ ...args, ...(await files(JSON.stringify(answer))), fetch: stub });
  const { body, comments } = calls[0].payload;
  const safe = `cc @${Z}octocat, see #${Z}12 and o/r#${Z}13`;
  assert.equal(body.split(safe).length - 1, 2);
  assert.equal(comments[0].body, `🟡 ${safe}`);
});

test("neutralise breaks each form that GitHub links, and leaves other ampersands alone", () => {
  /** @type {[string, string][]} */
  const cases = [
    ["@octocat", `@${Z}octocat`],
    ["#12", `#${Z}12`],
    ["o/r#13", `o/r#${Z}13`],
    ["GH-1", `GH-${Z}1`],
    ["gh-1", `gh-${Z}1`],
    ["Gh-1", `Gh-${Z}1`],
    ["_GH-2_", `_GH-${Z}2_`],
    ["__GH-4__", `__GH-${Z}4__`],
    ["_gh-5_", `_gh-${Z}5_`],
    ["&#64;octocat", `&${Z}#${Z}64;octocat`],
    ["&#x40;octocat", `&${Z}#x40;octocat`],
    ["&#X40;octocat", `&${Z}#X40;octocat`],
    ["&commat;octocat", `&${Z}commat;octocat`],
    ["&#35;1", `&${Z}#${Z}35;1`],
    ["&#x23;1", `&${Z}#x23;1`],
    ["&num;1", `&${Z}num;1`],
    ["a && b &amp; c", "a && b &amp; c"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(failureBody(sha, input, "").split("\n").at(-1), expected, input);
  }
});

test("failureBody neutralises mentions and issue references in the reason and the raw text", () => {
  const body = failureBody(sha, "Bad: @a", "raw #5 @b");
  assert.match(body, new RegExp(`Bad: @${Z}a`));
  assert.match(body, new RegExp(`raw #${Z}5 @${Z}b`));
});

test("a finding path can't pair with a backtick that ends the finding before it", () => {
  const findings = [{ ...outsideFinding, body: "ends with a backtick `" }, { ...outsideFinding, path: "@octocat", body: "next" }];
  const body = reviewBody({ sha, answer: { summary, findings: [] }, inBody: findings, dropped: [], diffCut: false });
  assert.ok(body.startsWith("## Gemini review of abc1234def"));
  assert.ok(body.includes(`\n\`@${Z}octocat:9\` — 🔴 next`), body);
  assert.doesNotMatch(body, /@(?!\u200b)/);
});

test("a finding path with a pipe in a summary table row can't split its code span into a mention", () => {
  const table = { ...summary, critical: "h1 | h2\n--- | ---" };
  const body = reviewBody({
    sha,
    answer: { summary: table, findings: [] },
    inBody: [{ ...outsideFinding, path: "x|@octocat" }],
    dropped: [],
    diffCut: false,
  });
  assert.ok(body.includes(`\`x|@${Z}octocat:9\``), body);
  assert.doesNotMatch(body, /@(?!\u200b)/);
});

test("reviewBody neutralises the Not seen entries", () => {
  const body = reviewBody({ sha, answer: { summary, findings: [] }, inBody: [], dropped: ["@org/team: deleted"], diffCut: false });
  assert.ok(body.includes(`- @${Z}org/team: deleted`), body);
});

test("reviewBody neutralises before the cut, so the cut body still fits", () => {
  const long = { ...summary, checked: "@".repeat(40000) };
  const body = reviewBody({ sha, answer: { summary: long, findings: [] }, inBody: [], dropped: [], diffCut: false });
  assert.ok(body.length <= 65536);
  assert.match(body.split("\n").at(-1) ?? "", /cut/);
});

test("a finding path with a backtick, an @ and a newline stays inside one code span", () => {
  const odd = { ...outsideFinding, path: "a`b @c\nd" };
  const body = reviewBody({ sha, answer: { summary, findings: [] }, inBody: [odd], dropped: [], diffCut: false });
  assert.match(body, /\*\*🔴 Critical Issues\*\*\n`` a`b @\u200bc d:9 `` — 🔴 Unchecked input\.\n\n\*\*/);
});

test("a finding whose body has several lines stays one list line", () => {
  const multi = { ...outsideFinding, body: "first\n\n  second\r\nthird" };
  const body = reviewBody({ sha, answer: { summary, findings: [] }, inBody: [multi], dropped: [], diffCut: false });
  assert.match(body, /\*\*🔴 Critical Issues\*\*\n`other\.txt:9` — 🔴 first second third\n\n\*\*/);
});

test("reviewBody lists the four sections, body findings under their severity and what was not seen", () => {
  const body = reviewBody({
    sha,
    answer: { summary, findings: [] },
    inBody: [outsideFinding],
    dropped: ["big.bin: over the size limit"],
    diffCut: true,
  });
  assert.ok(body.startsWith("## Gemini review of abc1234def"));
  assert.match(body, /\*\*🔴 Critical Issues\*\*\n`other\.txt:9` — 🔴 Unchecked input\./);
  assert.match(body, /\*\*🟡 Suggestions\*\*\nConsider a rename\./);
  assert.match(body, /\*\*🔵 Nits\*\*\nNone\./);
  assert.match(body, /\*\*✅ Checked\*\*\nRead a\.txt\./);
  assert.match(body, /Not seen[^]*- big\.bin: over the size limit[^]*- .*diff was cut/);
});

test("reviewBody omits the Not seen list when nothing was dropped", () => {
  const body = reviewBody({ sha, answer: { summary, findings: [] }, inBody: [], dropped: [], diffCut: false });
  assert.doesNotMatch(body, /Not seen/);
});

test("reviewBody cuts a body over 65536 characters and ends with a line saying so", () => {
  const long = { ...summary, checked: "c".repeat(70000) };
  const body = reviewBody({ sha, answer: { summary: long, findings: [] }, inBody: [], dropped: [], diffCut: false });
  assert.ok(body.length <= 65536);
  assert.match(body.split("\n").at(-1) ?? "", /cut/);
});

test("failureBody fences the raw text even when it contains a fence", () => {
  const body = failureBody(sha, "Gemini's answer was rejected", "```\nsneaky\n```");
  assert.match(body, /````\n```\nsneaky\n```\n````/);
});

test("post posts a failure body when the pack report is missing, unparsable or the wrong shape", async () => {
  for (const content of [undefined, "{not json", "{}", "null", '{"dropped":1}', '{"dropped":[1],"diffCut":false}', '{"dropped":[]}']) {
    const { stub, calls } = stubFetch([200]);
    const paths = await files(answerText([]));
    if (content === undefined) await rm(paths.packReport);
    else await writeFile(paths.packReport, content);
    await post({ ...args, ...paths, fetch: stub });
    assert.equal(calls.length, 1, String(content));
    assert.match(calls[0].payload.body, /The pack report could not be read\./, String(content));
  }
});

test("post posts a failure body when the diff file is unreadable", async () => {
  const { stub, calls } = stubFetch([200]);
  const paths = await files(answerText([]));
  await rm(paths.diffFile);
  await post({ ...args, ...paths, fetch: stub });
  assert.equal(calls.length, 1);
  assert.match(calls[0].payload.body, /The diff could not be read\./);
});

test("post ends in the failure post, without throwing, when the 422 retry fails too", async () => {
  const { stub, calls } = stubFetch([422, 500, 200]);
  await post({ ...args, ...(await files(answerText([inlineFinding]))), fetch: stub });
  assert.equal(calls.length, 3);
  assert.match(calls[2].payload.body, /Posting the review failed \(HTTP 500\)\./);
});

test("reviewBody does not split a surrogate pair at the cut", () => {
  const emoji = "\u{1F600}";
  for (const offset of [0, 1]) {
    const long = { ...summary, checked: "c".repeat(offset) + emoji.repeat(40000) };
    const body = reviewBody({ sha, answer: { summary: long, findings: [] }, inBody: [], dropped: [], diffCut: false });
    assert.ok(body.length <= 65536);
    assert.ok(body.isWellFormed());
  }
});

test("failureBody handles a raw answer with 300,000 backtick runs", () => {
  const body = failureBody(sha, "failed", "`a".repeat(300000));
  assert.ok(body.startsWith("## Gemini review of abc1234def"));
});

test("a finding path with 300,000 backtick runs still makes a body", () => {
  const odd = { ...outsideFinding, path: "`a".repeat(300000) };
  const body = reviewBody({ sha, answer: { summary, findings: [] }, inBody: [odd], dropped: [], diffCut: false });
  assert.ok(body.length > 0);
});

test("failureBody does not split a surrogate pair at the cut", () => {
  const emoji = "\u{1F600}";
  for (const offset of [0, 1]) {
    const body = failureBody(sha, "failed", "c".repeat(offset) + emoji.repeat(4000));
    assert.ok(body.isWellFormed());
  }
});
