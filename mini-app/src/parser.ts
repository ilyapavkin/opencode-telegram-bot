export type PatchLineKind = "addition" | "deletion" | "context" | "hunk" | "meta";

export interface PatchLine {
  kind: PatchLineKind;
  raw: string;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export type PatchSegment =
  { type: "lines"; lines: PatchLine[] } | { type: "collapsed"; count: number };

export interface SideBySideRow {
  kind: "addition" | "deletion" | "context" | "hunk" | "meta";
  left: PatchLine | null;
  right: PatchLine | null;
}

export function parsePatch(patch: string): PatchLine[] {
  const rawLines = patch.replace(/\r\n/g, "\n").split("\n");
  if (rawLines.at(-1) === "") {
    rawLines.pop();
  }

  let oldLine = 0;
  let newLine = 0;
  return rawLines.map((raw) => {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return line("hunk", raw, raw, null, null);
    }

    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const parsed = line("addition", raw, raw.slice(1), null, newLine);
      newLine += 1;
      return parsed;
    }

    if (raw.startsWith("-") && !raw.startsWith("---")) {
      const parsed = line("deletion", raw, raw.slice(1), oldLine, null);
      oldLine += 1;
      return parsed;
    }

    if (raw.startsWith(" ")) {
      const parsed = line("context", raw, raw.slice(1), oldLine, newLine);
      oldLine += 1;
      newLine += 1;
      return parsed;
    }

    return line("meta", raw, raw, null, null);
  });
}

export function collapseContext(lines: readonly PatchLine[], contextLines = 3): PatchSegment[] {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === "addition" || line.kind === "deletion") {
      for (let offset = -contextLines; offset <= contextLines; offset += 1) {
        const candidate = index + offset;
        if (candidate >= 0 && candidate < lines.length && lines[candidate]?.kind === "context") {
          keep.add(candidate);
        }
      }
    }
  });

  const segments: PatchSegment[] = [];
  let visible: PatchLine[] = [];
  let hiddenCount = 0;
  const flushVisible = (): void => {
    if (visible.length > 0) {
      segments.push({ type: "lines", lines: visible });
      visible = [];
    }
  };
  const flushHidden = (): void => {
    if (hiddenCount > 0) {
      segments.push({ type: "collapsed", count: hiddenCount });
      hiddenCount = 0;
    }
  };

  lines.forEach((line, index) => {
    if (line.kind === "context" && !keep.has(index)) {
      flushVisible();
      hiddenCount += 1;
      return;
    }

    flushHidden();
    visible.push(line);
  });
  flushVisible();
  flushHidden();
  return segments;
}

export function toSideBySide(lines: readonly PatchLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const current = lines[index];
    if (current === undefined) {
      break;
    }

    if (current.kind === "deletion") {
      const deletions: PatchLine[] = [];
      while (lines[index]?.kind === "deletion") {
        const deletion = lines[index];
        if (deletion !== undefined) deletions.push(deletion);
        index += 1;
      }
      const additions: PatchLine[] = [];
      while (lines[index]?.kind === "addition") {
        const addition = lines[index];
        if (addition !== undefined) additions.push(addition);
        index += 1;
      }
      const count = Math.max(deletions.length, additions.length);
      for (let offset = 0; offset < count; offset += 1) {
        rows.push({
          kind:
            deletions[offset] === undefined
              ? "addition"
              : additions[offset] === undefined
                ? "deletion"
                : "addition",
          left: deletions[offset] ?? null,
          right: additions[offset] ?? null,
        });
      }
      continue;
    }

    if (current.kind === "addition") {
      rows.push({ kind: "addition", left: null, right: current });
    } else {
      rows.push({
        kind: current.kind,
        left: current,
        right: current.kind === "context" ? current : null,
      });
    }
    index += 1;
  }
  return rows;
}

export function collapseSideBySide(
  rows: readonly SideBySideRow[],
  contextLines = 3,
): Array<SideBySideRow | { kind: "collapsed"; count: number }> {
  const keep = new Set<number>();
  rows.forEach((row, index) => {
    if (row.kind === "addition" || row.kind === "deletion") {
      for (let offset = -contextLines; offset <= contextLines; offset += 1) {
        const candidate = index + offset;
        if (candidate >= 0 && candidate < rows.length && rows[candidate]?.kind === "context") {
          keep.add(candidate);
        }
      }
    }
  });

  const result: Array<SideBySideRow | { kind: "collapsed"; count: number }> = [];
  let hiddenCount = 0;
  const flushHidden = (): void => {
    if (hiddenCount > 0) {
      result.push({ kind: "collapsed", count: hiddenCount });
      hiddenCount = 0;
    }
  };
  rows.forEach((row, index) => {
    if (row.kind === "context" && !keep.has(index)) {
      hiddenCount += 1;
      return;
    }
    flushHidden();
    result.push(row);
  });
  flushHidden();
  return result;
}

function line(
  kind: PatchLineKind,
  raw: string,
  text: string,
  oldLine: number | null,
  newLine: number | null,
): PatchLine {
  return { kind, raw, text, oldLine, newLine };
}
