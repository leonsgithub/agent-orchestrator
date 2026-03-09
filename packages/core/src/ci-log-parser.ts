/**
 * CI Log Parser — categorizes CI failures from log output.
 *
 * Parses raw CI log text and classifies failures into actionable categories.
 * Extracts relevant file paths and error snippets for fix agents.
 */

import type { CIFailureCategory } from "./types.js";

export interface ParsedCIFailure {
  category: CIFailureCategory;
  message: string;
  filePaths: string[];
  errorSnippet: string;
}

/** Max length for error snippets passed to fix agents */
const MAX_SNIPPET_LENGTH = 2000;

/** Extract file paths from error output (e.g. "src/foo.ts:12:5: error ...") */
function extractFilePaths(text: string): string[] {
  const paths = new Set<string>();
  // Match patterns like "src/foo.ts:12" or "./src/foo.ts(12,5)"
  const patterns = [
    /(?:^|\s)([\w./-]+\.\w{1,10})(?::(\d+))/gm, // path:line
    /(?:^|\s)([\w./-]+\.\w{1,10})(?:\((\d+),\d+\))/gm, // path(line,col)
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const p = match[1];
      if (p && !p.startsWith("http") && !p.includes("node_modules")) {
        paths.add(p);
      }
    }
  }
  return [...paths].slice(0, 20);
}

/** Truncate text to max length, preserving the most relevant part */
function truncateSnippet(text: string, maxLen: number = MAX_SNIPPET_LENGTH): string {
  if (text.length <= maxLen) return text;
  // Try to find the first error line and keep context around it
  const errorIdx = text.search(/error|Error|FAIL|FAILED/i);
  if (errorIdx > 0 && errorIdx < text.length - maxLen / 2) {
    const start = Math.max(0, errorIdx - 200);
    return "..." + text.slice(start, start + maxLen - 6) + "...";
  }
  return text.slice(0, maxLen - 3) + "...";
}

/** Categorization rules — order matters, first match wins */
const CATEGORIZERS: Array<{
  category: CIFailureCategory;
  test: (log: string, stepName: string) => boolean;
  message: (log: string) => string;
}> = [
  {
    category: "merge-conflict",
    test: (log) =>
      /CONFLICT|merge conflict|Merge conflict|cannot merge/i.test(log),
    message: () => "Merge conflicts detected",
  },
  {
    category: "dependency-conflict",
    test: (log, step) =>
      (/npm install|pip install|pnpm install|yarn install|poetry install/i.test(step) ||
        /npm ERR!|pip.*error|Could not resolve dependencies|ERESOLVE/i.test(log)),
    message: (log) => {
      const match = log.match(/(?:npm ERR!|ERESOLVE|Could not resolve).*/i);
      return match ? match[0].slice(0, 200) : "Dependency installation failed";
    },
  },
  {
    category: "type-error",
    test: (log, step) =>
      /tsc|typecheck|type-check/i.test(step) ||
      /TS\d{4}:|error TS\d{4}/i.test(log),
    message: (log) => {
      const errors = log.match(/error TS\d{4}:.*/g);
      return errors
        ? `${errors.length} TypeScript error(s): ${errors[0].slice(0, 200)}`
        : "TypeScript type check failed";
    },
  },
  {
    category: "lint-failure",
    test: (log, step) =>
      /lint|eslint|prettier|biome|ruff|flake8|pylint/i.test(step) ||
      /eslint|✖ \d+ problem/i.test(log),
    message: (log) => {
      const match = log.match(/✖ (\d+) problem/);
      return match ? `Lint: ${match[0]}` : "Lint check failed";
    },
  },
  {
    category: "test-failure",
    test: (log, step) =>
      /test|pytest|vitest|jest|mocha/i.test(step) ||
      /FAILED|FAIL.*test|AssertionError|test.*failed/i.test(log),
    message: (log) => {
      const match = log.match(/(\d+) failed/i);
      return match ? `${match[0]} test(s)` : "Test suite failed";
    },
  },
  {
    category: "build-failure",
    test: (log, step) =>
      /build|compile|webpack|vite|next build|cargo build/i.test(step) ||
      /Build failed|Compilation failed|Module not found/i.test(log),
    message: (log) => {
      const match = log.match(/(?:Error|error|Module not found).*/i);
      return match ? match[0].slice(0, 200) : "Build failed";
    },
  },
  {
    category: "infra-failure",
    test: (log) =>
      /runner.*timeout|OOM|out of memory|SIGKILL|network.*error|ETIMEDOUT/i.test(log),
    message: () => "Infrastructure failure (timeout/OOM/network)",
  },
];

/**
 * Parse CI log output and categorize the failure.
 *
 * @param logText Raw CI log output
 * @param stepName Name of the CI step that failed (e.g., "test", "lint", "build")
 */
export function parseCILog(logText: string, stepName: string = ""): ParsedCIFailure {
  const normalizedStep = stepName.toLowerCase();

  for (const rule of CATEGORIZERS) {
    if (rule.test(logText, normalizedStep)) {
      return {
        category: rule.category,
        message: rule.message(logText),
        filePaths: extractFilePaths(logText),
        errorSnippet: truncateSnippet(logText),
      };
    }
  }

  return {
    category: "unknown",
    message: "CI step failed (unrecognized failure pattern)",
    filePaths: extractFilePaths(logText),
    errorSnippet: truncateSnippet(logText),
  };
}

/**
 * Check if a failure looks like a flaky test (heuristic).
 * A test is considered flaky if:
 * - It matches known flaky patterns (timeout, race condition keywords)
 * - The failure is intermittent (same test passed in recent runs)
 */
export function isLikelyFlaky(logText: string): boolean {
  return /flaky|intermittent|race condition|timeout.*retry|ECONNRESET|socket hang up/i.test(
    logText,
  );
}
