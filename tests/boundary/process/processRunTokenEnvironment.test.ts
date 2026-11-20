import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";

import { readProcessRunId } from "../../../src/process/ProcessOwnership.js";
import { createSystemProcessOwnershipHost } from "../../../src/process/ProcessOwnershipObservation.js";
import { readProcessRunTokens } from "../../../src/process/ProcessRunTokenObservations.js";
import { processTest } from "../../support/process/processFixture.js";

const gcc = spawnSync("gcc", ["--version"], { encoding: "utf8" });

processTest.skipIf(process.platform !== "linux").for([
  { name: "absent", runId: undefined },
  { name: "selected", runId: "source-process-token" },
])(
  "reads $name run tokens from the live process environment",
  async ({ runId }, { processes }) => {
    const environment = {
      EMPTY: "",
      VALUE: "a=b",
      ["__proto__"]: "source-value",
      ...(runId === undefined ? {} : { REA_PROCESS_RUN_ID: runId }),
    };
    const child = processes.spawn(
      process.execPath,
      ["-e", "process.stdin.resume()"],
      { env: environment },
    );
    await once(child, "spawn");
    const host = createSystemProcessOwnershipHost("linux", {});
    const row = (await host.listProcesses()).find(
      ({ pid }) => pid === child.pid,
    );
    if (row === undefined) throw new Error("Selected child was not observed");

    expect(await host.environment(row.pid)).toEqual(environment);
    expect(await readProcessRunId(row.pid, host)).toBe(runId);
    const observations = [];
    for await (const observation of readProcessRunTokens(host, [row]))
      observations.push(observation);
    expect(observations).toEqual([
      { process: row, observation: { state: "readable", runId } },
    ]);
    child.stdin.end();
  },
);

const WIPE_ENVIRONMENT = `#include <string.h>
#include <unistd.h>
extern char **environ;
int main(void) {
  for (char **entry = environ; entry != NULL && *entry != NULL; entry++)
    memset(*entry, 0, strlen(*entry));
  if (write(1, "ready\\n", 6) != 6) return 1;
  for (;;) pause();
}
`;

processTest.skipIf(process.platform !== "linux" || gcc.status !== 0)(
  "reports a NUL-wiped Linux environ image as an unreadable run token",
  async ({ processes }) => {
    const directory = await mkdtemp(join(tmpdir(), "rea-environ-"));
    try {
      const source = join(directory, "wipe.c");
      const binary = join(directory, "wipe");
      await writeFile(source, WIPE_ENVIRONMENT);
      const compiled = await processes.run("gcc", [
        "-O2",
        "-o",
        binary,
        source,
      ]);
      expect(compiled.exitCode, compiled.stderr).toBe(0);
      const child = processes.spawn(binary, [], {
        env: {
          REA_PROCESS_RUN_ID: "probe-owned",
          OTHER: "value",
        },
      });
      let ready = "";
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("wiped child did not become ready")),
          5_000,
        );
        child.stdout.on("data", (chunk: Buffer) => {
          ready += chunk.toString("utf8");
          if (!ready.includes("ready")) return;
          clearTimeout(timer);
          resolve();
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`wiped child exited early (${String(code)})`));
        });
      });
      const host = createSystemProcessOwnershipHost("linux", {});
      const row = (await host.listProcesses()).find(
        ({ pid }) => pid === child.pid,
      );
      if (row === undefined) throw new Error("Wiped child was not observed");
      await expect(host.environment(row.pid)).rejects.toMatchObject({
        name: "LinuxEnvironmentImageOverwritten",
      });
      expect(await readProcessRunId(row.pid, host)).toBeUndefined();
      const observations = [];
      for await (const observation of readProcessRunTokens(host, [row]))
        observations.push(observation);
      expect(observations).toEqual([
        {
          process: row,
          observation: {
            state: "readable",
            runId: undefined,
            environmentImage: "overwritten",
          },
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
