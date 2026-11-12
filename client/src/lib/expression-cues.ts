export type DeliveryMood =
  | "neutral"
  | "playful"
  | "excited"
  | "sad"
  | "calm";

export type VocalizationCue = "laugh" | "giggle" | "sob";

export type ExpressionSegment =
  | { kind: "speech"; text: string; mood: DeliveryMood }
  | { kind: "vocalization"; cue: VocalizationCue };

export const MAX_VOCALIZATION_CUES = 6;

const CUE_PATTERN =
  /\[(mood:(?:neutral|playful|excited|sad|calm)|laugh|giggle|sob)\]/gi;

export interface ExpressionAnalysis {
  segments: ExpressionSegment[];
  spokenText: string;
  hasSpeech: boolean;
  hasVocalization: boolean;
  needsLaughSample: boolean;
  needsSobSample: boolean;
  missingSamples: string[];
  vocalizationCount: number;
  tooManyVocalizations: boolean;
}

export function analyzeExpressionScript(
  script: string,
  hasLaughSample = false,
  hasSobSample = false
): ExpressionAnalysis {
  const segments: ExpressionSegment[] = [];
  let mood: DeliveryMood = "neutral";
  let cursor = 0;
  let match: RegExpExecArray | null;
  const pattern = new RegExp(CUE_PATTERN.source, "gi");

  const addSpeech = (value: string) => {
    const text = value.trim();
    if (text) segments.push({ kind: "speech", text, mood });
  };

  while ((match = pattern.exec(script)) !== null) {
    addSpeech(script.slice(cursor, match.index));
    const directive = match[1].toLowerCase();
    if (directive.startsWith("mood:")) {
      mood = directive.slice("mood:".length) as DeliveryMood;
    } else {
      segments.push({
        kind: "vocalization",
        cue: directive as VocalizationCue,
      });
    }
    cursor = pattern.lastIndex;
  }
  addSpeech(script.slice(cursor));

  const speechSegments = segments.filter(
    (segment): segment is Extract<ExpressionSegment, { kind: "speech" }> =>
      segment.kind === "speech"
  );
  const vocalizationSegments = segments.filter(
    (segment): segment is Extract<ExpressionSegment, { kind: "vocalization" }> =>
      segment.kind === "vocalization"
  );
  const spokenText = speechSegments.map(segment => segment.text).join(" ");
  const needsLaughSample = vocalizationSegments.some(
    segment => segment.cue === "laugh" || segment.cue === "giggle"
  );
  const needsSobSample = vocalizationSegments.some(
    segment => segment.cue === "sob"
  );

  return {
    segments,
    spokenText,
    hasSpeech: speechSegments.length > 0,
    hasVocalization: vocalizationSegments.length > 0,
    needsLaughSample,
    needsSobSample,
    missingSamples: [
      ...(needsLaughSample && !hasLaughSample ? ["laugh/giggle"] : []),
      ...(needsSobSample && !hasSobSample ? ["cry/sob"] : []),
    ],
    vocalizationCount: vocalizationSegments.length,
    tooManyVocalizations:
      vocalizationSegments.length > MAX_VOCALIZATION_CUES,
  };
}
