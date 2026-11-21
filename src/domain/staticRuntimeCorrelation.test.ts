import { unknownTarget } from "./targetIdentity.js";
import { describe, expect, it } from "vitest";
import { ARTIFACT_COMPARISON_EXAMPLE } from "../contracts/artifactComparisonExample.js";
import { FUNCTION_COMPARISON_EVIDENCE } from "../contracts/investigationExamples.js";
import {
  artifactComparisonResultSchema,
  compareArtifacts,
} from "./artifactComparison.js";
import { memberInventoryEvidence } from "./staticRuntimeCorrelation.fixture.js";
import { findChangedBehavior } from "./changedBehavior.js";
import { ARTIFACT_COMPARISON_PROVIDER } from "./comparisonEvidenceIdentity.js";
import {
  createEvidence,
  type Evidence,
  evidenceSubjectInput,
} from "./evidence.js";
import { functionComparisonResultSchema } from "./functionComparisonSchemas.js";
import { jsonValueSchema, type JsonValue } from "./jsonValue.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../contracts/functionComparisonExample.js";
import { functionDossierSchema } from "./native/functionDossier.js";
import { compareFunctions } from "./functionComparison.js";
import { functionSnapshotFixture } from "./functionDossierEvidence.fixture.js";
import {
  correlateStaticAndRuntime,
  staticRuntimeCorrelationResultSchema,
} from "./staticRuntimeCorrelation.js";

const staticComparison = FUNCTION_COMPARISON_EVIDENCE;

const artifactComparison = createEvidence(
  unknownTarget("derived-from-linked-evidence"),
  ARTIFACT_COMPARISON_PROVIDER,
  {
    predicateType: "rea.artifact-comparison",
    operation: "compare_artifacts",
    parameters: {
      left_evidence_ids: [ARTIFACT_COMPARISON_EXAMPLE.left.evidence_id],
      right_evidence_ids: [ARTIFACT_COMPARISON_EXAMPLE.right.evidence_id],
    },
    result: compareArtifacts(
      ARTIFACT_COMPARISON_EXAMPLE.left,
      ARTIFACT_COMPARISON_EXAMPLE.right,
    ),
    confidence: "derived",
    authority: "analyst-inference",
    evidenceLinks: [
      ARTIFACT_COMPARISON_EXAMPLE.left.evidence_id,
      ARTIFACT_COMPARISON_EXAMPLE.right.evidence_id,
    ],
  },
);

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

const leftCapture = capture("1");
const rightCapture = capture("2");

const processComparison = (
  terminal: "unchanged" | "changed" | "unknown" | "truncated",
): Evidence => {
  const result = {
    status: terminal,
    terminal,
    interaction: terminal === "truncated" ? "truncated" : "unchanged",
    exit: terminal === "truncated" ? "truncated" : "unchanged",
    filesystem: terminal === "truncated" ? "truncated" : "unchanged",
    process: terminal === "truncated" ? "truncated" : "unchanged",
    first_divergence:
      terminal === "changed"
        ? {
            status: "found",
            dimension: "terminal",
            index: 0,
            left_at_ms: 0,
            right_at_ms: 0,
            left: "left",
            right: "right",
          }
        : terminal === "truncated" || terminal === "unknown"
          ? { status: "unknown", reason: "Incomplete fixture." }
          : { status: "none" },
    limitations: terminal === "unknown" ? ["Terminal unavailable."] : [],
  } satisfies JsonValue;
  return createEvidence(
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
      result,
      confidence: "derived",
      authority: "analyst-inference",
      evidenceLinks: [leftCapture.evidence_id, rightCapture.evidence_id],
    },
  );
};

const mapping = (
  runtime: Evidence,
  expected: "cochanged" | "static_only" | "runtime_only" | "both_unchanged",
  dimension: string = "terminal",
) => ({
  static_comparisons: [staticComparison],
  runtime_comparisons: [runtime],
  mappings: [
    {
      static: {
        comparison_evidence_id: staticComparison.evidence_id,
        selector: {
          kind: "function" as const,
          dimension: "pseudocode" as const,
        },
      },
      runtime: {
        comparison_evidence_id: runtime.evidence_id,
        dimension,
      },
      side_alignment: "left_to_left" as const,
      hypothesis: {
        statement: "The static edit is associated with terminal behavior.",
        expected_pattern: expected,
      },
    },
  ],
});

it("keeps text, assembly and unavailable CFG caveats on their selected correlations", () => {
  const source = FUNCTION_COMPARISON_EXAMPLE.left;
  const left = createEvidence(
    { path: "/tmp/unavailable-cfg", sha256: "a".repeat(64), format: "mach-o" },
    source.provider,
    {
      operation: source.operation,
      parameters: source.parameters,
      result: {
        ...functionDossierSchema.parse(source.normalized_result),
        basic_blocks: [{ start: "0x1000", end: "0x1000", successors: [] }],
      },
      confidence: source.confidence,
      authority: source.authority,
    },
  );

  const right = FUNCTION_COMPARISON_EXAMPLE.right;
  const computed = compareFunctions(
    functionSnapshotFixture(left),
    functionSnapshotFixture(right),
  );
  const comparison = createEvidence(
    unknownTarget("derived-from-linked-evidence"),
    staticComparison.provider,
    {
      predicateType: "rea.function-comparison",
      operation: "compare_functions",
      parameters: {
        left_evidence_id: left.evidence_id,
        right_evidence_id: right.evidence_id,
      },
      result: computed,
      confidence: "derived",
      authority: "analyst-inference",
      limitations: computed.limitations,
      evidenceLinks: [left.evidence_id, right.evidence_id],
    },
  );
  const input = mapping(processComparison("unchanged"), "static_only");
  const result = correlateStaticAndRuntime({
    ...input,
    static_comparisons: [comparison],
    mappings: ["pseudocode", "assembly", "cfg"].map((dimension) => ({
      ...input.mappings[0],
      static: {
        comparison_evidence_id: comparison.evidence_id,
        selector: { kind: "function", dimension },
      },
    })),
  });
  expect(result.status).toBe("unknown");
  const caveats = new Map(
    result.correlations.items.map((item) => [
      item.static.selector.kind === "function"
        ? item.static.selector.dimension
        : "artifact",
      item.limitations.join(" "),
    ]),
  );
  expect(caveats.get("pseudocode")).toMatch(/generated-name normalization/u);
  expect(caveats.get("pseudocode")).not.toMatch(
    /Assembly is opaque|CFG addresses/u,
  );
  expect(caveats.get("assembly")).toMatch(/Assembly is opaque/u);
  expect(caveats.get("assembly")).not.toMatch(/CFG addresses/u);
  expect(caveats.get("cfg")).toMatch(/CFG addresses/u);
  expect(caveats.get("cfg")).not.toMatch(
    /generated-name normalization|Assembly is opaque/u,
  );
});

describe("static/runtime correlation", () => {
  it("uses the selected interaction status even when the terminal changed", () => {
    const runtime = processComparison("changed");
    expect(
      correlateStaticAndRuntime(mapping(runtime, "static_only", "interaction")),
    ).toMatchObject({
      status: "correlated",
      correlations: {
        items: [{ runtime: { dimension: "interaction", status: "unchanged" } }],
      },
    });
  });

  it("rejects duplicate static comparison selection", () => {
    const runtime = processComparison("changed");
    const base = mapping(runtime, "cochanged");
    expect(() =>
      correlateStaticAndRuntime({
        ...base,
        static_comparisons: [staticComparison, staticComparison],
      }),
    ).toThrowError(
      expect.objectContaining({
        _tag: "AnalysisInputError",
        issues: [expect.objectContaining({ path: ["static_comparisons", 1] })],
      }),
    );
  });

  it("rejects a static comparison with an unsupported operation", () => {
    const runtime = processComparison("changed");
    const base = mapping(runtime, "cochanged");
    expect(() =>
      correlateStaticAndRuntime({
        ...base,
        static_comparisons: [leftCapture],
      }),
    ).toThrowError(
      expect.objectContaining({
        _tag: "AnalysisInputError",
        issues: [expect.objectContaining({ path: ["static_comparisons", 0] })],
      }),
    );
  });

  it("classifies malformed source Evidence as an integrity failure", () => {
    const runtime = processComparison("changed");
    const base = mapping(runtime, "cochanged");
    const malformedEvidence = {
      ...staticComparison,
      evidence_id: "ev_invalid",
    };
    expect(() =>
      correlateStaticAndRuntime({
        ...base,
        static_comparisons: [malformedEvidence],
      }),
    ).toThrowError(
      expect.objectContaining({
        _tag: "EvidenceIntegrityError",
        cause: expect.any(Error),
      }),
    );
  });
});

describe("static/runtime correlation outcomes", () => {
  it("keeps consistent cochange as a hypothesis with complete citations", () => {
    const runtime = processComparison("changed");
    const result = correlateStaticAndRuntime(mapping(runtime, "cochanged"));
    expect(staticRuntimeCorrelationResultSchema.parse(result)).toMatchObject({
      status: "correlated",
      summary: { hypotheses: 1, contradictions: 0, unresolved: 0 },
      correlations: {
        items: [
          {
            observed_pattern: "cochanged",
            classification: "hypothesis",
            side_alignment: "left_to_left",
          },
        ],
      },
    });
    expect(result.correlations.items[0]?.evidence_links).toEqual(
      expect.arrayContaining([
        staticComparison.evidence_id,
        runtime.evidence_id,
        leftCapture.evidence_id,
        rightCapture.evidence_id,
      ]),
    );
    expect(result.limitations.join(" ")).toMatch(
      /does not establish causality/u,
    );
    expect(result.correlations.items[0]?.limitations.join(" ")).toMatch(
      /generated-name normalization/u,
    );
  });

  it("classifies an explicit expectation mismatch as contradiction", () => {
    const result = correlateStaticAndRuntime(
      mapping(processComparison("unchanged"), "cochanged"),
    );
    expect(result).toMatchObject({
      status: "contradicted",
      summary: { hypotheses: 0, contradictions: 1, unresolved: 0 },
      correlations: {
        items: [
          { observed_pattern: "static_only", classification: "contradiction" },
        ],
      },
    });
  });

  it("lets unknown and truncation dominate rather than imply equivalence", () => {
    const unknown = correlateStaticAndRuntime(
      mapping(processComparison("unknown"), "cochanged"),
    );
    const truncated = correlateStaticAndRuntime(
      mapping(processComparison("truncated"), "cochanged"),
    );
    expect(unknown).toMatchObject({
      status: "unknown",
      correlations: { items: [{ classification: "unresolved_branch" }] },
    });
    expect(truncated).toMatchObject({
      status: "truncated",
      correlations: { items: [{ observed_pattern: "truncated" }] },
    });
  });
});

describe("static/runtime correlation selection", () => {
  it("returns all correlations order-stably and rejects duplicates and absent selectors", () => {
    const runtime = processComparison("changed");
    const base = mapping(runtime, "cochanged");
    const second = {
      ...base.mappings[0],
      runtime: { ...base.mappings[0]!.runtime, dimension: "exit" as const },
      hypothesis: {
        statement: "The edit is associated with exit behavior.",
        expected_pattern: "static_only" as const,
      },
    };
    const forward = correlateStaticAndRuntime({
      ...base,
      mappings: [base.mappings[0], second],
    });
    const reversed = correlateStaticAndRuntime({
      ...base,
      mappings: [second, base.mappings[0]],
    });
    expect(reversed).toEqual(forward);
    expect(forward.correlations.items).toHaveLength(2);
    expect(() =>
      correlateStaticAndRuntime({
        ...base,
        mappings: [base.mappings[0], base.mappings[0]],
      }),
    ).toThrowError(
      expect.objectContaining({
        _tag: "AnalysisInputError",
        operation: "correlate_static_and_runtime",
        userMessage: expect.stringContaining("duplicate mappings"),
        issues: [expect.objectContaining({ path: ["mappings", 1] })],
      }),
    );
    expect(() =>
      correlateStaticAndRuntime({
        ...base,
        mappings: [
          {
            ...base.mappings[0],
            static: {
              ...base.mappings[0]!.static,
              selector: { kind: "function", dimension: "assembly" },
            },
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      correlateStaticAndRuntime({
        ...base,
        mappings: [
          {
            ...base.mappings[0],
            static: {
              comparison_evidence_id: runtime.evidence_id,
              selector: { kind: "function", dimension: "pseudocode" },
            },
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        _tag: "AnalysisInputError",
        userMessage: expect.stringContaining("absent static comparison"),
        issues: [
          expect.objectContaining({
            path: ["mappings", 0, "static", "comparison_evidence_id"],
          }),
        ],
      }),
    );
    expect(() =>
      correlateStaticAndRuntime({
        ...base,
        mappings: [
          {
            ...base.mappings[0],
            runtime: {
              ...base.mappings[0]!.runtime,
              comparison_evidence_id: staticComparison.evidence_id,
            },
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        _tag: "AnalysisInputError",
        issues: [
          expect.objectContaining({
            path: ["mappings", 0, "runtime", "comparison_evidence_id"],
          }),
        ],
      }),
    );
  });
});

describe("static/runtime correlation Evidence validation", () => {
  it("rejects comparison citations that disagree with source parameters", () => {
    const runtime = processComparison("changed");
    const forged = createEvidence(
      evidenceSubjectInput(runtime.subject),
      runtime.provider,
      {
        predicateType: runtime.predicate_type,
        operation: runtime.operation,
        parameters: {
          left_evidence_id: leftCapture.evidence_id,
          right_evidence_id: staticComparison.evidence_id,
        },
        result: runtime.normalized_result,
        confidence: runtime.confidence,
        authority: runtime.authority,
        evidenceLinks: runtime.evidence_links,
      },
    );
    const input = mapping(forged, "cochanged");
    expect(() => correlateStaticAndRuntime(input)).toThrowError(
      expect.toSatisfy(
        (error: { _tag?: unknown; userMessage?: unknown; cause?: unknown }) =>
          error._tag === "EvidenceIntegrityError" &&
          typeof error.userMessage === "string" &&
          error.userMessage.includes(
            "closure disagrees with its source parameters",
          ) &&
          error.cause === undefined,
      ),
    );
  });

  it("retains invalid authenticated result payloads as Evidence failures", () => {
    const valid = processComparison("changed");
    const malformed = createEvidence(
      evidenceSubjectInput(valid.subject),
      valid.provider,
      {
        predicateType: valid.predicate_type,
        operation: valid.operation,
        parameters: valid.parameters,
        result: { status: "changed" },
        confidence: valid.confidence,
        authority: valid.authority,
        evidenceLinks: valid.evidence_links,
      },
    );
    expect(() =>
      correlateStaticAndRuntime(mapping(malformed, "cochanged")),
    ).toThrowError(
      expect.objectContaining({
        _tag: "EvidenceIntegrityError",
        cause: expect.any(Error),
      }),
    );
  });
});

describe("static/runtime correlation citation closure", () => {
  it("accepts extra parent citations for changed behavior but rejects them for correlation", () => {
    const runtime = processComparison("changed");
    const extra = staticComparison.evidence_id;
    const extended = createEvidence(
      evidenceSubjectInput(runtime.subject),
      runtime.provider,
      {
        predicateType: runtime.predicate_type,
        operation: runtime.operation,
        parameters: runtime.parameters,
        result: runtime.normalized_result,
        confidence: runtime.confidence,
        authority: runtime.authority,
        evidenceLinks: [...runtime.evidence_links, extra],
      },
    );
    const aggregated = findChangedBehavior({ comparisons: [extended] });
    expect(aggregated.result.behavior_status).toBe("observed_changed");
    expect(aggregated.result.evidence_links).toContain(extra);
    expect(() =>
      correlateStaticAndRuntime(mapping(extended, "cochanged")),
    ).toThrowError(
      expect.toSatisfy(
        (error: { _tag?: unknown; userMessage?: unknown; cause?: unknown }) =>
          error._tag === "EvidenceIntegrityError" &&
          error.userMessage ===
            "Comparison Evidence closure disagrees with its source parameters" &&
          error.cause === undefined,
      ),
    );
  });

  it.each([
    ["function", staticComparison],
    ["artifact", artifactComparison],
  ] as const)(
    "rejects authenticated %s citations outside the top-level Evidence closure",
    (_kind, base) => {
      const outside = `ev_${"f".repeat(64)}`;
      let result: JsonValue;
      if (base.operation === "compare_functions") {
        const parsed = functionComparisonResultSchema.parse(
          base.normalized_result,
        );
        const dimensions = parsed.dimensions.map((dimension) => ({
          ...dimension,
          evidence_links: [...dimension.evidence_links, outside],
        }));
        result = jsonValueSchema.parse(
          functionComparisonResultSchema.parse({
            ...parsed,
            dimensions,
            changes: dimensions.filter(({ status }) => status !== "unchanged"),
          }),
        );
      } else {
        const parsed = artifactComparisonResultSchema.parse(
          base.normalized_result,
        );
        expect(parsed.changes.length).toBeGreaterThan(0);
        result = jsonValueSchema.parse({
          ...parsed,
          changes: parsed.changes.map((change) => ({
            ...change,
            evidence_links: [...change.evidence_links, outside],
          })),
        });
      }
      const danglingNested = createEvidence(
        evidenceSubjectInput(base.subject),
        base.provider,
        {
          predicateType: base.predicate_type,
          operation: base.operation,
          parameters: base.parameters,
          result,
          confidence: base.confidence,
          authority: base.authority,
          evidenceLinks: base.evidence_links,
        },
      );
      const input = mapping(processComparison("changed"), "cochanged");
      expect(() =>
        correlateStaticAndRuntime({
          ...input,
          static_comparisons: [danglingNested],
          mappings: input.mappings.map((item) => ({
            ...item,
            static: {
              comparison_evidence_id: danglingNested.evidence_id,
              selector:
                base.operation === "compare_functions"
                  ? { kind: "function", dimension: "pseudocode" }
                  : { kind: "artifact", logical_path: "." },
            },
          })),
        }),
      ).toThrowError(
        expect.toSatisfy(
          (error: { _tag?: unknown; message?: unknown; cause?: unknown }) =>
            error._tag === "EvidenceIntegrityError" &&
            error.message ===
              "Comparison finding cites Evidence outside its top-level closure" &&
            error.cause === undefined,
        ),
      );
    },
  );
});

const UNCHANGED_MEMBER = "1".repeat(64);
const LEFT_CHANGED_MEMBER = "2".repeat(64);
const RIGHT_CHANGED_MEMBER = "3".repeat(64);
const UNCHANGED_PATH = "lib/deep/x.js";
const CHANGED_PATH = "lib/a.js";

const pairedMemberInventories = (
  coverage: { scope: "container-entries"; status: "complete" | "unknown" } = {
    scope: "container-entries",
    status: "complete",
  },
) => {
  const left = memberInventoryEvidence(
    [
      { path: CHANGED_PATH, sha256: LEFT_CHANGED_MEMBER },
      { path: UNCHANGED_PATH, sha256: UNCHANGED_MEMBER },
    ],
    "a".repeat(64),
    coverage,
  );
  const right = memberInventoryEvidence(
    [
      { path: CHANGED_PATH, sha256: RIGHT_CHANGED_MEMBER },
      { path: UNCHANGED_PATH, sha256: UNCHANGED_MEMBER },
    ],
    "b".repeat(64),
    coverage,
  );
  return { left, right };
};

const memberComparisonEvidence = (
  left: Evidence,
  right: Evidence,
  result: ReturnType<typeof compareArtifacts> = compareArtifacts(left, right),
): Evidence =>
  createEvidence(
    unknownTarget("derived-from-linked-evidence"),
    ARTIFACT_COMPARISON_PROVIDER,
    {
      predicateType: "rea.artifact-comparison",
      operation: "compare_artifacts",
      parameters: {
        left_evidence_ids: [left.evidence_id],
        right_evidence_ids: [right.evidence_id],
      },
      result,
      confidence: "derived",
      authority: "analyst-inference",
      limitations: result.limitations,
      evidenceLinks: [left.evidence_id, right.evidence_id],
    },
  );

const unchangedMemberRuntime = processComparison("changed");
const unchangedMemberPair = pairedMemberInventories();
const unchangedMemberCompared = compareArtifacts(
  unchangedMemberPair.left,
  unchangedMemberPair.right,
);
const unchangedMemberComparison = memberComparisonEvidence(
  unchangedMemberPair.left,
  unchangedMemberPair.right,
  unchangedMemberCompared,
);
const unchangedMemberById = (id: string): Evidence | undefined =>
  id === unchangedMemberPair.left.evidence_id
    ? unchangedMemberPair.left
    : id === unchangedMemberPair.right.evidence_id
      ? unchangedMemberPair.right
      : undefined;

const correlateMember = (
  path: string,
  pattern: "cochanged" | "runtime_only" | "both_unchanged",
  dimension: "terminal" | "exit",
  sources?: { readonly evidenceById: (id: string) => Evidence | undefined },
  staticComparison: Evidence = unchangedMemberComparison,
) =>
  correlateStaticAndRuntime(
    {
      static_comparisons: [staticComparison],
      runtime_comparisons: [unchangedMemberRuntime],
      mappings: [
        {
          static: {
            comparison_evidence_id: staticComparison.evidence_id,
            selector: { kind: "artifact" as const, logical_path: path },
          },
          runtime: {
            comparison_evidence_id: unchangedMemberRuntime.evidence_id,
            dimension,
          },
          side_alignment: "left_to_left" as const,
          hypothesis: {
            statement: "Compare selected observations.",
            expected_pattern: pattern,
          },
        },
      ],
    },
    sources,
  );

describe("unchanged artifact members in static/runtime correlation", () => {
  it("counts the identical member as unchanged and omits it from deltas", () => {
    expect(unchangedMemberCompared.summary).toMatchObject({
      unchanged: 1,
      added: 0,
      removed: 0,
      changed: 2,
      unknown: 0,
      contradiction: 0,
    });
    expect(
      unchangedMemberCompared.changes
        .map(({ logical_path: path }) => path)
        .sort(),
    ).toEqual([".", CHANGED_PATH].sort());
    expect(unchangedMemberRuntime.normalized_result).toMatchObject({
      terminal: "changed",
      exit: "unchanged",
    });
  });

  it("evaluates runtime_only and both_unchanged for a unique unchanged member", () => {
    const sources = { evidenceById: unchangedMemberById };
    expect(
      correlateMember(UNCHANGED_PATH, "runtime_only", "terminal", sources),
    ).toMatchObject({
      status: "correlated",
      summary: { hypotheses: 1, contradictions: 0, unresolved: 0 },
      correlations: {
        items: [
          {
            observed_pattern: "runtime_only",
            classification: "hypothesis",
            static: { status: "unchanged" },
            runtime: { dimension: "terminal", status: "changed" },
          },
        ],
      },
    });
    expect(
      correlateMember(UNCHANGED_PATH, "both_unchanged", "exit", sources),
    ).toMatchObject({
      status: "correlated",
      summary: { hypotheses: 1, contradictions: 0, unresolved: 0 },
      correlations: {
        items: [
          {
            observed_pattern: "both_unchanged",
            classification: "hypothesis",
            static: { status: "unchanged" },
            runtime: { dimension: "exit", status: "unchanged" },
          },
        ],
      },
    });
  });

  it("still evaluates a changed member, including a contradicted runtime_only hypothesis", () => {
    expect(
      correlateMember(CHANGED_PATH, "cochanged", "terminal", {
        evidenceById: unchangedMemberById,
      }),
    ).toMatchObject({
      status: "correlated",
      correlations: {
        items: [
          {
            observed_pattern: "cochanged",
            classification: "hypothesis",
            static: { status: "changed" },
          },
        ],
      },
    });
    expect(
      correlateMember(CHANGED_PATH, "runtime_only", "terminal"),
    ).toMatchObject({
      status: "contradicted",
      summary: { hypotheses: 0, contradictions: 1, unresolved: 0 },
      correlations: {
        items: [
          {
            observed_pattern: "cochanged",
            classification: "contradiction",
            static: { status: "changed" },
          },
        ],
      },
    });
  });
});

describe("unresolved unchanged artifact selectors", () => {
  it("leaves a missing delta unresolved when source inventories cannot establish unchanged", () => {
    const withoutSources = correlateMember(
      UNCHANGED_PATH,
      "runtime_only",
      "terminal",
    );
    expect(withoutSources).toMatchObject({
      status: "unknown",
      summary: { hypotheses: 0, contradictions: 0, unresolved: 1 },
      correlations: {
        items: [
          {
            observed_pattern: "unknown",
            classification: "unresolved_branch",
            static: { status: "unknown" },
          },
        ],
      },
    });
    expect(withoutSources.correlations.items[0]?.limitations.join(" ")).toMatch(
      /not a reported delta/u,
    );
    expect(withoutSources.correlations.items[0]?.limitations.join(" ")).toMatch(
      /source inventories are not available/u,
    );

    const absent = correlateMember(
      "lib/missing.js",
      "runtime_only",
      "terminal",
      {
        evidenceById: unchangedMemberById,
      },
    );
    expect(absent.correlations.items[0]).toMatchObject({
      classification: "unresolved_branch",
      static: { status: "unknown" },
    });
    expect(absent.correlations.items[0]?.limitations.join(" ")).toMatch(
      /not observed exactly once/u,
    );

    const incompleteInventories = pairedMemberInventories({
      scope: "container-entries",
      status: "unknown",
    });
    const incompleteComparison = memberComparisonEvidence(
      incompleteInventories.left,
      incompleteInventories.right,
    );
    expect(incompleteComparison.normalized_result).toMatchObject({
      summary: { unchanged: 0 },
    });
    const incomplete = correlateMember(
      UNCHANGED_PATH,
      "both_unchanged",
      "exit",
      {
        evidenceById: (id) =>
          id === incompleteInventories.left.evidence_id
            ? incompleteInventories.left
            : id === incompleteInventories.right.evidence_id
              ? incompleteInventories.right
              : undefined,
      },
      incompleteComparison,
    );
    expect(incomplete.correlations.items[0]).toMatchObject({
      classification: "unresolved_branch",
      static: { status: "unknown" },
    });
    expect(incomplete.correlations.items[0]?.limitations.join(" ")).toMatch(
      /incomplete inventory coverage/u,
    );
  });

  it("does not treat a cited omission as unchanged when the source inventories disagree", () => {
    const forged = artifactComparisonResultSchema.parse({
      ...unchangedMemberCompared,
      changes: unchangedMemberCompared.changes.filter(
        ({ logical_path: path }) => path !== CHANGED_PATH,
      ),
    });
    const cited = memberComparisonEvidence(
      unchangedMemberPair.left,
      unchangedMemberPair.right,
      forged,
    );
    const result = correlateMember(
      CHANGED_PATH,
      "runtime_only",
      "terminal",
      { evidenceById: unchangedMemberById },
      cited,
    );
    expect(result.correlations.items[0]).toMatchObject({
      classification: "unresolved_branch",
      observed_pattern: "unknown",
      static: { status: "unknown" },
    });
    expect(result.correlations.items[0]?.limitations.join(" ")).toMatch(
      /do not establish it as unchanged/u,
    );
  });

  it("rejects an artifact selector that matches more than one reported delta", () => {
    const duplicate = artifactComparisonResultSchema.parse({
      ...unchangedMemberCompared,
      changes: [
        unchangedMemberCompared.changes[0],
        unchangedMemberCompared.changes[0],
      ],
    });
    const cited = memberComparisonEvidence(
      unchangedMemberPair.left,
      unchangedMemberPair.right,
      duplicate,
    );
    expect(() =>
      correlateMember(
        duplicate.changes[0]!.logical_path,
        "cochanged",
        "terminal",
        undefined,
        cited,
      ),
    ).toThrowError(
      expect.objectContaining({
        _tag: "AnalysisInputError",
        userMessage:
          "Artifact selector must resolve exactly one reported delta",
        issues: [
          expect.objectContaining({
            path: ["mappings", 0, "static", "selector"],
            reason: "invalid_value",
          }),
        ],
      }),
    );
  });
});
