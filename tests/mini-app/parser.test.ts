import { describe, expect, it } from "vitest";
import {
  collapseContext,
  collapseSideBySide,
  parsePatch,
  toSideBySide,
} from "../../mini-app/src/parser.js";

describe("mini app patch parser", () => {
  it("parses hunk metadata and assigns old and new line numbers", () => {
    const lines = parsePatch(
      "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,4 +1,4 @@\n const first = true;\n-old value\n+new value\n const last = true;\n",
    );

    expect(lines[0]).toMatchObject({
      kind: "meta",
      text: "diff --git a/src/example.ts b/src/example.ts",
    });
    expect(lines[3]).toMatchObject({ kind: "hunk", oldLine: null, newLine: null });
    expect(lines[4]).toMatchObject({
      kind: "context",
      oldLine: 1,
      newLine: 1,
      text: "const first = true;",
    });
    expect(lines[5]).toMatchObject({
      kind: "deletion",
      oldLine: 2,
      newLine: null,
      text: "old value",
    });
    expect(lines[6]).toMatchObject({
      kind: "addition",
      oldLine: null,
      newLine: 2,
      text: "new value",
    });
    expect(lines[7]).toMatchObject({ kind: "context", oldLine: 3, newLine: 3 });
  });

  it("folds distant unchanged context while preserving nearby context", () => {
    const lines = parsePatch(
      "@@ -1,9 +1,9 @@\n one\n two\n three\n four\n-five\n+changed\n six\n seven\n eight\n nine\n",
    );

    const segments = collapseContext(lines, 1);

    expect(segments).toEqual([
      { type: "lines", lines: [lines[0]] },
      { type: "collapsed", count: 3 },
      { type: "lines", lines: [lines[4], lines[5], lines[6], lines[7]] },
      { type: "collapsed", count: 3 },
    ]);
  });

  it("pairs adjacent deletions and additions in side-by-side rows", () => {
    const lines = parsePatch("@@ -1,3 +1,2 @@\n-old one\n-old two\n+new one\n");

    expect(toSideBySide(lines)).toMatchObject([
      { kind: "hunk", left: { kind: "hunk" } },
      { kind: "addition", left: { text: "old one" }, right: { text: "new one" } },
      { kind: "deletion", left: { text: "old two" }, right: null },
    ]);
  });

  it("collapses context in side-by-side rows too", () => {
    const rows = toSideBySide(parsePatch("@@ -1,6 +1,6 @@\n a\n b\n c\n-d\n+d2\n e\n f\n"));

    expect(collapseSideBySide(rows, 1).map((row) => row.kind)).toEqual([
      "hunk",
      "collapsed",
      "context",
      "addition",
      "context",
      "collapsed",
    ]);
  });
});
