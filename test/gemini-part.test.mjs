import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { readAnswer } from "../.github/actions/review/contract.mjs";

test("the example answer in Gemini's prompt part passes the contract", async () => {
  const part = await readFile(new URL("../.github/actions/review/gemini-part.md", import.meta.url), "utf8");
  const example = /^```json\n([\s\S]*?)\n```$/m.exec(part);
  assert.ok(example, "gemini-part.md has no ```json block");

  const read = readAnswer(example[1]);

  assert.ok(read.ok, read.ok ? "" : read.reason);
});
