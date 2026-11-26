import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { parseDiff, placeFindings, readAnswer } from "../.github/actions/review/contract.mjs";

// mixed.diff is real `git -c core.quotePath=true diff --cached -M` output of a throwaway repo.
const mixedDiff = await readFile(new URL("./fixtures/mixed.diff", import.meta.url), "utf8");

/** @param {ReturnType<typeof parseDiff>} files @param {string} path */
const linesOf = (files, path) => {
  const lines = files.get(path);
  assert.ok(lines, `${path} is missing from the parsed diff`);
  return lines;
};

const sorted = (/** @type {Set<number>} */ lines) => [...lines].sort((a, b) => a - b);

test("parseDiff keys files by new path and decodes git's quoted path", () => {
  const files = parseDiff(mixedDiff);
  assert.deepEqual(
    [...files.keys()].sort(),
    ["added.txt", "dir with space/filé.md", "gone.txt", "img.bin", "mod.txt", "new-name.txt"],
  );
});

test("parseDiff gives an added file only right lines", () => {
  const added = linesOf(parseDiff(mixedDiff), "added.txt");
  assert.deepEqual(sorted(added.right), [1, 2, 3]);
  assert.equal(added.left.size, 0);
});

test("parseDiff counts context and added lines on the right, context and removed on the left", () => {
  const modified = linesOf(parseDiff(mixedDiff), "mod.txt");
  assert.deepEqual(sorted(modified.right), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(sorted(modified.left), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("parseDiff follows a rename with edits under the new path", () => {
  const files = parseDiff(mixedDiff);
  assert.equal(files.has("old-name.txt"), false);
  assert.deepEqual(sorted(linesOf(files, "new-name.txt").right), [1, 2, 3, 4, 5, 6]);
});

test("parseDiff keys a deletion by its old path with only left lines", () => {
  const gone = linesOf(parseDiff(mixedDiff), "gone.txt");
  assert.deepEqual(sorted(gone.left), [1, 2]);
  assert.equal(gone.right.size, 0);
});

test("parseDiff handles a quoted path with a space and an octal UTF-8 escape", () => {
  const file = linesOf(parseDiff(mixedDiff), "dir with space/filé.md");
  assert.deepEqual(sorted(file.right), [1, 2, 3, 4]);
  assert.deepEqual(sorted(file.left), [1, 2, 3]);
});

test("parseDiff gives a binary file an entry with empty sets", () => {
  const binary = linesOf(parseDiff(mixedDiff), "img.bin");
  assert.equal(binary.right.size, 0);
  assert.equal(binary.left.size, 0);
});

test("parseDiff decodes quote, backslash, tab and newline escapes", () => {
  const diff = [
    'diff --git "a/q\\"b\\\\c\\td\\ne" "b/q\\"b\\\\c\\td\\ne"',
    '--- "a/q\\"b\\\\c\\td\\ne"',
    '+++ "b/q\\"b\\\\c\\td\\ne"',
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "",
  ].join("\n");
  assert.deepEqual([...parseDiff(diff).keys()], ['q"b\\c\td\ne']);
});

test("parseDiff ignores the no-newline marker when counting lines", () => {
  const diff = [
    "diff --git a/f b/f",
    "--- a/f",
    "+++ b/f",
    "@@ -1 +1,2 @@",
    "-a",
    "\\ No newline at end of file",
    "+a",
    "+b",
    "",
  ].join("\n");
  const file = linesOf(parseDiff(diff), "f");
  assert.deepEqual(sorted(file.right), [1, 2]);
  assert.deepEqual(sorted(file.left), [1]);
});

test("parseDiff handles a hunk header without counts and a second hunk", () => {
  const diff = [
    "diff --git a/f b/f",
    "--- a/f",
    "+++ b/f",
    "@@ -3 +3 @@ function x",
    "-a",
    "+b",
    "@@ -10,2 +10,2 @@",
    " c",
    "-d",
    "+e",
    "",
  ].join("\n");
  const file = linesOf(parseDiff(diff), "f");
  assert.deepEqual(sorted(file.right), [3, 10, 11]);
  assert.deepEqual(sorted(file.left), [3, 10, 11]);
});

test("parseDiff returns an empty map for an empty diff", () => {
  assert.equal(parseDiff("").size, 0);
});

const validAnswer = {
  summary: { critical: "c", suggestions: "", nits: "n", checked: "k" },
  findings: [{ severity: "🔴", path: "a.js", line: 3, side: "RIGHT", body: "bad" }],
};

test("readAnswer accepts bare JSON", () => {
  const result = readAnswer(`\n${JSON.stringify(validAnswer)}\n`);
  assert.deepEqual(result, { ok: true, answer: validAnswer });
});

test("readAnswer accepts one json fenced block that is the whole text", () => {
  const result = readAnswer("```json\n" + JSON.stringify(validAnswer) + "\n```\n");
  assert.deepEqual(result, { ok: true, answer: validAnswer });
});

test("readAnswer accepts a CRLF-fenced block", () => {
  const result = readAnswer("```json\r\n" + JSON.stringify(validAnswer) + "\r\n```\r\n");
  assert.deepEqual(result, { ok: true, answer: validAnswer });
});

test("readAnswer accepts one bare fenced block that is the whole text", () => {
  const result = readAnswer("```\n" + JSON.stringify(validAnswer) + "\n```");
  assert.equal(result.ok, true);
});

test("readAnswer drops unknown keys", () => {
  const noisy = {
    extra: 1,
    summary: { ...validAnswer.summary, more: "x" },
    findings: [{ ...validAnswer.findings[0], suggestion: "x" }],
  };
  assert.deepEqual(readAnswer(JSON.stringify(noisy)), { ok: true, answer: validAnswer });
});

/** @param {string} text */
const reasonOf = (text) => {
  const result = readAnswer(text);
  assert.equal(result.ok, false);
  return result.reason;
};

test("readAnswer rejects prose around the JSON", () => {
  assert.match(reasonOf("Here you go:\n" + JSON.stringify(validAnswer)), /JSON/);
  assert.match(reasonOf(JSON.stringify(validAnswer) + "\nHope that helps"), /JSON/);
  assert.match(reasonOf("Sure\n```json\n" + JSON.stringify(validAnswer) + "\n```"), /JSON/);
});

test("readAnswer rejects two fenced blocks", () => {
  const block = "```json\n" + JSON.stringify(validAnswer) + "\n```";
  assert.match(reasonOf(block + "\n" + block), /JSON/);
});

test("readAnswer rejects empty text and a non-object answer", () => {
  assert.match(reasonOf(""), /JSON/);
  assert.match(reasonOf("[]"), /answer/);
});

test("readAnswer rejects a summary that is missing or not an object", () => {
  assert.match(reasonOf('{"findings":[]}'), /summary: must be an object/);
  assert.match(reasonOf(JSON.stringify({ ...validAnswer, summary: "text" })), /summary: must be an object/);
});

test("readAnswer names a missing summary key", () => {
  const { critical: _, ...summary } = validAnswer.summary;
  assert.match(reasonOf(JSON.stringify({ ...validAnswer, summary })), /summary\.critical/);
});

test("readAnswer names a non-string summary key", () => {
  const summary = { ...validAnswer.summary, nits: 4 };
  assert.match(reasonOf(JSON.stringify({ ...validAnswer, summary })), /summary\.nits/);
});

test("readAnswer names a missing findings array", () => {
  assert.match(reasonOf(JSON.stringify({ summary: validAnswer.summary })), /findings/);
});

test("readAnswer names the finding and field with a bad severity", () => {
  const findings = [validAnswer.findings[0], validAnswer.findings[0], { ...validAnswer.findings[0], severity: "⚠️" }];
  assert.equal(
    reasonOf(JSON.stringify({ ...validAnswer, findings })),
    "findings[2].severity: must be one of 🔴 🟡 🔵",
  );
});

test("readAnswer rejects line 0, a negative line and a non-integer line", () => {
  for (const line of [0, -1, 1.5, "3"]) {
    const findings = [{ ...validAnswer.findings[0], line }];
    assert.match(reasonOf(JSON.stringify({ ...validAnswer, findings })), /findings\[0\]\.line/);
  }
});

test("readAnswer rejects a bad side, an empty path and an empty body", () => {
  for (const [field, value] of [["side", "BOTH"], ["path", ""], ["body", ""]]) {
    const findings = [{ ...validAnswer.findings[0], [field]: value }];
    assert.match(reasonOf(JSON.stringify({ ...validAnswer, findings })), new RegExp(`findings\\[0\\]\\.${field}`));
  }
});

test("readAnswer rejects a finding that is not an object", () => {
  assert.match(reasonOf(JSON.stringify({ ...validAnswer, findings: [null] })), /findings\[0\]/);
});

const hunks = parseDiff(mixedDiff);

/** @param {string} path @param {number} line @param {"RIGHT"|"LEFT"} [side] */
const finding = (path, line, side = "RIGHT") => ({ severity: /** @type {const} */ ("🟡"), path, line, side, body: "b" });

test("placeFindings puts a finding on a changed line inline", () => {
  const f = finding("mod.txt", 3);
  assert.deepEqual(placeFindings([f], hunks), { inline: [f], inBody: [] });
});

test("placeFindings checks the line against the finding's side", () => {
  const onLeft = finding("gone.txt", 1, "LEFT");
  const wrongSide = finding("gone.txt", 1, "RIGHT");
  assert.deepEqual(placeFindings([onLeft, wrongSide], hunks), { inline: [onLeft], inBody: [wrongSide] });
});

test("placeFindings moves a path outside the diff and a line outside a hunk to the body, in order", () => {
  const elsewhere = finding("nope.txt", 1);
  const outside = finding("mod.txt", 99);
  const inside = finding("mod.txt", 2);
  assert.deepEqual(placeFindings([elsewhere, inside, outside], hunks), {
    inline: [inside],
    inBody: [elsewhere, outside],
  });
});

test("placeFindings caps inline at 50 and sends the rest to the body in order", () => {
  const many = Array.from({ length: 53 }, (_, i) => finding("big.txt", i + 1));
  const big = new Map([["big.txt", { right: new Set(many.map((f) => f.line)), left: new Set() }]]);
  const { inline, inBody } = placeFindings(many, big);
  assert.deepEqual(inline, many.slice(0, 50));
  assert.deepEqual(inBody, many.slice(50));
});
