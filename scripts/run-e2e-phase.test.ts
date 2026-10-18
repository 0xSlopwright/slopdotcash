import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The release runner uses Node. Bun's child-process termination has different
// descendant semantics on Windows, so execute the real helper in Node too.
const driver = String.raw`
const {runE2ePhase}=await import(process.argv[1]);
const fs=await import('node:fs');
const {join}=await import('node:path');
const root=process.argv[2],ready=join(root,'ready'),done=join(root,'done');
const descendant="const fs=require('node:fs');fs.writeFileSync("+JSON.stringify(ready)+",'ready');setTimeout(()=>{fs.writeFileSync("+JSON.stringify(done)+",'done');process.exit(0)},8000);";
const launcher="require('node:child_process').spawn(process.execPath,['-e',"+JSON.stringify(descendant)+"],{stdio:'inherit',detached:true,windowsHide:true});setInterval(()=>{},1000);";
const result=await runE2ePhase({label:'deadline regression',command:process.execPath,args:['-e',launcher],cwd:root,env:process.env,timeoutMs:3000});
const observed={result,ready:fs.existsSync(ready),doneAtReturn:fs.existsSync(done)};
const deadline=Date.now()+15000;
while(!fs.existsSync(done)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
observed.finished=fs.existsSync(done);
observed.success=await runE2ePhase({label:'completed regression',command:process.execPath,args:['-e',"process.stdout.write('phase finished\\n')"],cwd:root,env:process.env,timeoutMs:5000});
fs.writeFileSync(join(root,'result.json'),JSON.stringify(observed));
`;

test("Node phase deadlines settle before inherited pipes close and keep normal success", () => {
  const root = mkdtempSync(join(tmpdir(), "slop-phase-deadline-"));
  const helper = pathToFileURL(join(import.meta.dir, "run-e2e-phase.mjs"));
  try {
    const run = spawnSync("node", ["-e", driver, helper.href, root], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.status).toBe(0);
    const observed = JSON.parse(
      readFileSync(join(root, "result.json"), "utf8"),
    );
    expect(observed.result).toBe(1);
    expect(observed.ready).toBe(true);
    expect(observed.doneAtReturn).toBe(false);
    expect(observed.finished).toBe(true);
    expect(observed.success).toBe(0);
  } finally {
    // The native descendant ends itself; never leave a background fixture.
    if (existsSync(join(root, "done")))
      rmSync(root, { recursive: true, force: true });
  }
}, 40_000);
