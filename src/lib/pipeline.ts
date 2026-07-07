import { extractJson } from "./extract-json";
import { mockStream, type MockBehavior, type MockState } from "./anthropic-mock";

export interface GenerateInput {
  /** Drives the mock streaming client (see anthropic-mock.ts). */
  behavior: MockBehavior;
  /** Hands the finished draft to the next pipeline stage. May reject. */
  advanceToNextStage: () => Promise<void>;
  /** Returns true once the draft passes review. Scripted by callers/tests. */
  reviewPasses: (attempt: number) => boolean;
}

export interface GenerateResult {
  status: "ok" | "error";
  attempts: number;
}

const MAX_REVISIONS = 3;
const MAX_STREAM_ATTEMPTS = 3;

function isTransient429Error(error: unknown): boolean {
  return (
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number" &&
    error.status === 429
  );
}

function isJsonExtractionError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error && error.message === "No fenced JSON block found")
  );
}

async function streamValidDraft(
  behavior: MockBehavior,
  state: MockState,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_STREAM_ATTEMPTS; attempt += 1) {
    try {
      const text = await mockStream(behavior, state);
      extractJson(text);
      return;
    } catch (error) {
      lastError = error;

      if (!isTransient429Error(error) && !isJsonExtractionError(error)) {
        break;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Draft streaming failed");
}

/**
 * Runs one content-generation pass: stream a draft, extract it, revise until it
 * passes review, then hand off to the next stage.
 *
 * This is a faithful (stripped-down) reproduction of the real pipeline — and it
 * ships with three real bugs from that pipeline. Your job is to fix them so the
 * test suite passes. See the README for the symptoms. (Do not edit the tests.)
 */
export async function generate(input: GenerateInput): Promise<GenerateResult> {
  const state: MockState = { calls: 0 };

  try {
    await streamValidDraft(input.behavior, state);
  } catch {
    return { status: "error", attempts: state.calls };
  }

  for (let attempt = 1; attempt <= MAX_REVISIONS; attempt += 1) {
    if (!input.reviewPasses(attempt)) {
      continue;
    }

    try {
      await input.advanceToNextStage();
      return { status: "ok", attempts: attempt };
    } catch {
      return { status: "error", attempts: attempt };
    }
  }

  return { status: "error", attempts: MAX_REVISIONS };
}

export { MAX_REVISIONS };
