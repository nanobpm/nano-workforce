// #837 — every dataGrid renders as the urban card list at every width: the fixed-max-width shell
// clips wide tables on any monitor, while the card view shows every field.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("#837: the pages surface opts into the app-wide card layout", () => {
  const manifest = JSON.parse(readFileSync("nano.app.json", "utf8"));
  assert.equal(manifest.surfaces?.pages?.gridLayout, "cards");
});
