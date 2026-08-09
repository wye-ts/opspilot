// Hand-rolled, dependency-free glob matcher (`*` per segment, `**` any
// depth, literal segments otherwise). No glob-matching dependency in the repo
// is safe to import undeclared (`picomatch` is only transitive), and a
// narrow hand-written matcher matches the repo's existing preference for
// narrow logic over libraries for narrow needs.

const REGEXP_SPECIAL = new Set([".", "+", "^", "$", "(", ")", "[", "]", "{", "}", "|", "\\"]);

function escapeRegExpChar(char: string): string {
  return REGEXP_SPECIAL.has(char) ? `\\${char}` : char;
}

function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    out += escapeRegExpChar(c as string);
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

export function matchesPattern(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path);
}

export function matchesAnyPattern(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPattern(path, pattern));
}
