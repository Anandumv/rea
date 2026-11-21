import { ARTIFACT_COMPARISON_EXAMPLE } from "../contracts/artifactComparisonExample.js";
import {
  artifactInventoryResultSchema,
  type ArtifactInventoryCoverage,
  type ArtifactOccurrence,
} from "./artifactGraph.js";
import {
  artifactGraphDigest,
  artifactIdForContent,
  artifactManifestId,
  occurrenceIdForLocation,
} from "./artifactIdentity.js";
import { createEvidence, type Evidence } from "./evidence.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

/** Inventory Evidence with one root and the supplied container members. */
export const memberInventoryEvidence = (
  members: readonly { readonly path: string; readonly sha256: string }[],
  rootSha256: string,
  coverage: ArtifactInventoryCoverage = {
    scope: "container-entries",
    status: "complete",
  },
): Evidence => {
  const inventory = artifactInventoryResultSchema.parse(
    ARTIFACT_COMPARISON_EXAMPLE.left.normalized_result,
  );
  const root = inventory.occurrences[0];
  const rootNode = inventory.nodes[0];
  if (root === undefined || rootNode === undefined)
    throw new Error("Artifact comparison example is missing its root");
  const rootId = artifactIdForContent(rootSha256);
  root.artifact_id = rootId;
  root.occurrence_id = occurrenceIdForLocation({
    rootArtifactId: rootId,
    logicalPath: ".",
    entryKind: root.entry_kind,
  });
  rootNode.artifact_id = rootId;
  rootNode.sha256 = rootSha256;
  inventory.manifest.root_artifact_id = rootId;
  inventory.manifest.root_sha256 = rootSha256;
  for (const member of members) {
    const artifactId = artifactIdForContent(member.sha256);
    const occurrence: ArtifactOccurrence = {
      ...root,
      occurrence_id: occurrenceIdForLocation({
        rootArtifactId: rootId,
        logicalPath: member.path,
        entryKind: "file",
      }),
      artifact_id: artifactId,
      parent_occurrence_id: root.occurrence_id,
      relationship_coverage: "complete",
      logical_path: member.path,
    };
    inventory.nodes.push({
      ...rootNode,
      artifact_id: artifactId,
      sha256: member.sha256,
    });
    inventory.occurrences.push(occurrence);
  }
  inventory.nodes.sort((left, right) =>
    compareUnicodeCodePoints(left.artifact_id, right.artifact_id),
  );
  inventory.coverage = coverage;
  inventory.manifest.root_sha256 = rootSha256;
  inventory.manifest.node_count = inventory.nodes.length;
  inventory.manifest.occurrence_count = inventory.occurrences.length;
  inventory.manifest.edge_count = inventory.edges.length;
  const graphSha256 = artifactGraphDigest({
    nodes: inventory.nodes,
    occurrences: inventory.occurrences,
    edges: inventory.edges,
    contradictions: inventory.integrity_contradictions,
  });
  inventory.manifest.graph_sha256 = graphSha256;
  inventory.manifest.manifest_id = artifactManifestId(rootId, graphSha256);
  return createEvidence(
    {
      path: `members-${rootSha256.slice(0, 8)}`,
      sha256: rootSha256,
      format: inventory.manifest.root_format,
    },
    ARTIFACT_COMPARISON_EXAMPLE.left.provider,
    {
      operation: "inventory_artifact",
      parameters: {},
      result: inventory,
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );
};
