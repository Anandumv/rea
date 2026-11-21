import { expect, it } from "vitest";

import { compareArtifacts } from "../../domain/artifactComparison.js";
import { ARTIFACT_COMPARISON_PROVIDER } from "../../domain/comparisonEvidenceIdentity.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { memberInventoryEvidence } from "../../domain/staticRuntimeCorrelation.fixture.js";
import { staticRuntimeCorrelationResultSchema } from "../../domain/staticRuntimeCorrelation.js";
import { unknownTarget } from "../../domain/targetIdentity.js";
import { InvestigationRecords } from "./InvestigationRecords.js";
import { correlateStaticAndRuntimeEvidence } from "./InvestigationWorkflows.js";

const UNCHANGED_PATH = "lib/deep/x.js";
const CHANGED_PATH = "lib/a.js";

const capture = (digit: string): Evidence =>
  createEvidence(
    unknownTarget("not-observed"),
    { id: "fixture", name: "Fixture", version: "1" },
    {
      predicateType: "rea.process-capture",
      operation: "capture_process_scenario",
      parameters: {},
      result: { digit },
      authority: "controlled-replay",
      environment: {
        id: `fixture-${digit}`,
        platform: "test",
        architecture: "test",
        isolation: "process",
      },
    },
  );

const retainedUnchangedMemberCorrelation = () => {
  const unchanged = "1".repeat(64);
  const left = memberInventoryEvidence(
    [
      { path: CHANGED_PATH, sha256: "2".repeat(64) },
      { path: UNCHANGED_PATH, sha256: unchanged },
    ],
    "a".repeat(64),
  );
  const right = memberInventoryEvidence(
    [
      { path: CHANGED_PATH, sha256: "3".repeat(64) },
      { path: UNCHANGED_PATH, sha256: unchanged },
    ],
    "b".repeat(64),
  );
  const compared = compareArtifacts(left, right);
  const comparison = createEvidence(
    unknownTarget("derived-from-linked-evidence"),
    ARTIFACT_COMPARISON_PROVIDER,
    {
      predicateType: "rea.artifact-comparison",
      operation: "compare_artifacts",
      parameters: {
        left_evidence_ids: [left.evidence_id],
        right_evidence_ids: [right.evidence_id],
      },
      result: compared,
      confidence: "derived",
      authority: "analyst-inference",
      limitations: compared.limitations,
      evidenceLinks: [left.evidence_id, right.evidence_id],
    },
  );
  const leftCapture = capture("1");
  const rightCapture = capture("2");
  const runtimeResult = {
    status: "changed",
    terminal: "changed",
    interaction: "unchanged",
    exit: "unchanged",
    filesystem: "unchanged",
    process: "unchanged",
    first_divergence: {
      status: "found",
      dimension: "terminal",
      index: 0,
      left_at_ms: 0,
      right_at_ms: 0,
      left: "1",
      right: "2",
    },
    limitations: [],
  } satisfies JsonValue;
  const runtime = createEvidence(
    unknownTarget("derived-from-linked-evidence"),
    {
      id: "rea-process",
      name: "REA deterministic process harness",
      version: "3",
    },
    {
      predicateType: "rea.process-comparison",
      operation: "compare_process_captures",
      parameters: {
        left_evidence_id: leftCapture.evidence_id,
        right_evidence_id: rightCapture.evidence_id,
      },
      result: runtimeResult,
      confidence: "derived",
      authority: "analyst-inference",
      evidenceLinks: [leftCapture.evidence_id, rightCapture.evidence_id],
    },
  );
  const records = new InvestigationRecords();
  for (const evidence of [
    left,
    right,
    comparison,
    leftCapture,
    rightCapture,
    runtime,
  ]) {
    const recorded = records.recordEvidence(evidence);
    expect(recorded.ok).toBe(true);
  }
  const result = correlateStaticAndRuntimeEvidence(
    {
      static_comparisons: [
        { kind: "retained-evidence", evidence_id: comparison.evidence_id },
      ],
      runtime_comparisons: [
        { kind: "retained-evidence", evidence_id: runtime.evidence_id },
      ],
      mappings: [
        {
          static: {
            comparison_evidence_id: comparison.evidence_id,
            selector: { kind: "artifact", logical_path: UNCHANGED_PATH },
          },
          runtime: {
            comparison_evidence_id: runtime.evidence_id,
            dimension: "terminal",
          },
          side_alignment: "left_to_left",
          hypothesis: {
            statement: "Compare selected observations.",
            expected_pattern: "runtime_only",
          },
        },
        {
          static: {
            comparison_evidence_id: comparison.evidence_id,
            selector: { kind: "artifact", logical_path: UNCHANGED_PATH },
          },
          runtime: {
            comparison_evidence_id: runtime.evidence_id,
            dimension: "exit",
          },
          side_alignment: "left_to_left",
          hypothesis: {
            statement: "Compare selected observations.",
            expected_pattern: "both_unchanged",
          },
        },
      ],
    },
    { evidenceForAnalysis: (id) => records.evidenceForAnalysis(id) },
  );
  return result;
};

it("evaluates an unchanged artifact member retained in the session closure", () => {
  const result = retainedUnchangedMemberCorrelation();
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const payload = staticRuntimeCorrelationResultSchema.parse(
    result.value.evidence.normalized_result,
  );
  expect(payload).toMatchObject({
    status: "correlated",
    summary: { hypotheses: 2, contradictions: 0, unresolved: 0 },
  });
  expect(payload.correlations.items).toHaveLength(2);
  expect(payload.correlations.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        observed_pattern: "runtime_only",
        classification: "hypothesis",
        static: expect.objectContaining({ status: "unchanged" }),
      }),
      expect.objectContaining({
        observed_pattern: "both_unchanged",
        classification: "hypothesis",
        static: expect.objectContaining({ status: "unchanged" }),
      }),
    ]),
  );
});
