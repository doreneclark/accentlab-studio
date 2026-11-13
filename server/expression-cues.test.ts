import { describe, expect, it } from "vitest";
import {
  MAX_VOCALIZATION_CUES,
  analyzeExpressionScript,
} from "../client/src/lib/expression-cues";

describe("expression cue parser", () => {
  it("removes controls from speech while preserving the spoken words and event order", () => {
    const result = analyzeExpressionScript(
      "[mood:playful]That was my joke. [laugh] [mood:sad]I miss you. [sob]"
    );

    expect(result.spokenText).toBe("That was my joke. I miss you.");
    expect(result.segments).toEqual([
      { kind: "speech", text: "That was my joke.", mood: "playful" },
      { kind: "vocalization", cue: "laugh" },
      { kind: "speech", text: "I miss you.", mood: "sad" },
      { kind: "vocalization", cue: "sob" },
    ]);
  });

  it("keeps a mood active until the next mood cue, including neutral", () => {
    const result = analyzeExpressionScript(
      "[mood:excited]Really? Still excited. [mood:neutral]Now calm."
    );
    expect(result.segments).toEqual([
      { kind: "speech", text: "Really? Still excited.", mood: "excited" },
      { kind: "speech", text: "Now calm.", mood: "neutral" },
    ]);
  });

  it("makes laugh/giggle samples optional but keeps sob samples required", () => {
    const missing = analyzeExpressionScript("[laugh][giggle][sob]");
    expect(missing.hasSpeech).toBe(false);
    expect(missing.hasVocalization).toBe(true);
    expect(missing.hasLaughCue).toBe(true);
    expect(missing.needsSobSample).toBe(true);
    expect(missing.hasRenderableVocalization).toBe(false);
    expect(missing.missingSamples).toEqual(["cry/sob"]);

    const laughSupplied = analyzeExpressionScript("[laugh][giggle]", true);
    expect(laughSupplied.missingSamples).toEqual([]);
    expect(laughSupplied.hasRenderableVocalization).toBe(true);

    const sobSupplied = analyzeExpressionScript("[giggle][sob]", true, true);
    expect(sobSupplied.missingSamples).toEqual([]);
    expect(sobSupplied.hasRenderableVocalization).toBe(true);
  });

  it("does not consider a missing laugh sample playable for an event-only take", () => {
    const skipped = analyzeExpressionScript("[giggle]");
    expect(skipped.hasSpeech).toBe(false);
    expect(skipped.hasRenderableVocalization).toBe(false);
    expect(skipped.missingSamples).toEqual([]);
  });

  it("does not treat mood-only controls as spoken content", () => {
    const result = analyzeExpressionScript("[mood:playful]");
    expect(result.hasSpeech).toBe(false);
    expect(result.hasVocalization).toBe(false);
    expect(result.spokenText).toBe("");
  });

  it("caps inserted non-speech events per generation", () => {
    const cues = Array.from({ length: MAX_VOCALIZATION_CUES + 1 }, () =>
      "[laugh]"
    ).join("");
    expect(analyzeExpressionScript(cues, true).tooManyVocalizations).toBe(true);
  });
});
