import { DarwinProcessOwnershipInspectionError } from "./DarwinProcessRunTokenReader.js";
import {
  assertProcessOwnershipInspectionActive,
  rethrowProcessOwnershipInspectionFailure,
} from "./ProcessInspectionCancellation.js";
import type {
  ProcessOwnershipHost,
  ProcessRunTokenObservation,
  ProcessTableEntry,
} from "./ProcessOwnership.js";
import { liveProcesses } from "./ProcessOwnershipProcessTree.js";
import { errorMessage } from "../kernel/errorMessage.js";

/** Stable diagnostic for a Linux environ image that is not a variable list. */
export const LINUX_ENVIRONMENT_IMAGE_OVERWRITTEN =
  "linux_environment_image_overwritten";

/**
 * Linux read `/proc/<pid>/environ`, but the bytes are not an environment
 * variable list. Chromium's process-title support produces this image.
 * The process id is known to the caller that caught this error.
 */
export class LinuxEnvironmentImageOverwritten extends Error {
  readonly _tag = "LinuxEnvironmentImageOverwritten";
  constructor() {
    super(LINUX_ENVIRONMENT_IMAGE_OVERWRITTEN);
    this.name = "LinuxEnvironmentImageOverwritten";
  }
}

/** Lineage and cleanup wording for one or more overwritten environ images. */
export const overwrittenLinuxEnvironmentReason = (
  pids: readonly number[],
): string => {
  const listed = [...new Set(pids)]
    .sort((left, right) => left - right)
    .map((pid) => String(pid));
  const subject =
    listed.length === 1
      ? `PID ${listed[0] ?? ""}`
      : `PIDs ${listed.join(", ")}`;
  return `Linux /proc environment image for ${subject} is not a variable list, so REA_PROCESS_RUN_ID cannot be read; Chromium-based processes overwrite this memory and lineage ownership remains unverified`;
};

/** Structured native token availability, distinct from failed reads and caller cancellation. */
export class ProcessRunTokenReadError extends Error {
  readonly _tag = "ProcessRunTokenReadError";
  constructor(
    readonly pid: number,
    readonly availability: "absent" | "unavailable",
    readonly reason: string,
  ) {
    super(`Run token for PID ${String(pid)}: ${reason}`);
    this.name = "ProcessRunTokenReadError";
  }
}

/** Only a variable observed on this process supplies its run token. */
export const processRunIdFromEnvironment = (
  environment: Readonly<Record<string, string>>,
): string | undefined =>
  Object.hasOwn(environment, "REA_PROCESS_RUN_ID")
    ? environment.REA_PROCESS_RUN_ID
    : undefined;

/** Read a selected PID's environment token without requiring process-table relations. */
export const readProcessRunToken = async (
  host: ProcessOwnershipHost,
  pid: number,
  signal?: AbortSignal,
): Promise<ProcessRunTokenObservation> => {
  assertProcessOwnershipInspectionActive(signal);
  try {
    const environment =
      signal === undefined
        ? await host.environment(pid)
        : await host.environment(pid, signal);
    assertProcessOwnershipInspectionActive(signal);
    return {
      state: "readable",
      runId: processRunIdFromEnvironment(environment),
    };
  } catch (cause: unknown) {
    // Keep this readable. An unavailable token would fail a whole-system sweep
    // on every unrelated Chromium process, which is not ownership proof either.
    if (cause instanceof LinuxEnvironmentImageOverwritten)
      return {
        state: "readable",
        runId: undefined,
        environmentImage: "overwritten",
      };
    if (
      cause instanceof DarwinProcessOwnershipInspectionError &&
      (cause.cleanupOwner !== undefined || cause.cleanupFailure !== undefined)
    )
      throw cause;
    rethrowProcessOwnershipInspectionFailure(cause);
    const code =
      cause instanceof Error &&
      "code" in cause &&
      typeof cause.code === "string"
        ? cause.code
        : undefined;
    return {
      state: "unavailable",
      ...(code === undefined ? {} : { code }),
      reason: errorMessage(cause),
    };
  }
};

/** Read only ownership tokens, using per-process fallback for missing batch rows. */
export async function* readProcessRunTokens(
  host: ProcessOwnershipHost,
  processes: readonly ProcessTableEntry[],
  signal?: AbortSignal,
): AsyncGenerator<{
  readonly process: ProcessTableEntry;
  readonly observation: ProcessRunTokenObservation;
}> {
  assertProcessOwnershipInspectionActive(signal);
  if (processes.length === 0) return;
  let batch: ReadonlyMap<number, ProcessRunTokenObservation> | undefined;
  let batchFailure: string | undefined;
  if (host.runTokens !== undefined) {
    try {
      batch =
        signal === undefined
          ? await host.runTokens(processes)
          : await host.runTokens(processes, signal);
    } catch (cause: unknown) {
      if (
        cause instanceof DarwinProcessOwnershipInspectionError &&
        (cause.cleanupOwner !== undefined || cause.cleanupFailure !== undefined)
      )
        throw cause;
      rethrowProcessOwnershipInspectionFailure(cause);
      batchFailure = errorMessage(cause);
    }
  }
  for (const process of processes) {
    assertProcessOwnershipInspectionActive(signal);
    let observation = batch?.get(process.pid);
    if (observation === undefined) {
      observation = await readProcessRunToken(host, process.pid, signal);
      if (observation.state === "unavailable" && batchFailure !== undefined)
        observation = {
          ...observation,
          reason: `${observation.reason}; run-token batch failed: ${batchFailure}`,
        };
    }
    assertProcessOwnershipInspectionActive(signal);
    yield { process, observation };
  }
}

/**
 * Live processes in the current process table that expose this run token.
 * A process whose token cannot be read is left out, so the list proves
 * presence only; it does not prove that no other carrier exists.
 */
export const readRunTokenCarriers = async (
  host: ProcessOwnershipHost,
  runId: string,
  signal?: AbortSignal,
): Promise<readonly ProcessTableEntry[]> => {
  const carriers: ProcessTableEntry[] = [];
  const processes = liveProcesses(
    signal === undefined
      ? await host.listProcesses()
      : await host.listProcesses(signal),
  );
  for await (const { process, observation } of readProcessRunTokens(
    host,
    processes,
    signal,
  ))
    if (observation.state === "readable" && observation.runId === runId)
      carriers.push(process);
  return carriers;
};
