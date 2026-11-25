import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {mkdir, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
import {parseArgs} from "node:util";

const {values} = parseArgs({options:{suite:{type:"string",default:"all"},hosting:{type:"string"}}});
const {suite,hosting} = values;
if (!["all","web","worker","models","native"].includes(suite))
  throw Error("Use --suite all, web, worker, models, or native.");
if (!process.env.npm_execpath) throw Error("Run this pipeline with npm run eval.");
const root = fileURLToPath(new URL("../",import.meta.url));
const agent = join(root,"agent");
const output = join(root,"artifacts","atlas-eval",suite);
const localPython = join(agent,".venv",...(process.platform === "win32" ? ["Scripts","python.exe"] : ["bin","python"]));
const python = process.env.ATLAS_EVAL_PYTHON || (existsSync(localPython) ? localPython : "python");
const env = {...process.env, ATLAS_EVAL_PYTHON:python, NEXT_TELEMETRY_DISABLED:"1"};
const npm = (...args) => [process.execPath,process.env.npm_execpath,...args];
const stages = [];

async function run(name, command, cwd = root) {
  console.log("\n" + name);
  const started = Date.now();
  const exitCode = await new Promise(resolve => {
    const [program,...args] = command;
    const child = spawn(program,args,{cwd,env,stdio:"inherit",windowsHide:true});
    child.once("error",error => {console.error(error.message);resolve(1);});
    child.once("close",code => resolve(code ?? 1));
  });
  stages.push({name,status:exitCode ? "failed" : "passed",exitCode,durationMs:Date.now()-started});
  return exitCode === 0;
}

if (suite === "all" || suite === "web") {
  await run("Finance and application unit tests",npm("test"));
  await run("API unit and contract tests",npm("test","--prefix","api"));
  if (await run("Production build and type checking",npm("run","build"))) {
    await run("Static browser journeys",npm("run","test:browser"));
  } else stages.push({name:"Static browser journeys",status:"skipped",reason:"Build failed"});
}
if (suite === "all" || suite === "worker") {
  await run("Python worker tests",[python,"-m","unittest","discover","-v"],agent);
  await run("HTTP API to ADK evaluation",[process.execPath,"--test","tests/eval-api.mjs"]);
}
if (suite === "models") {
  await run("Live model evaluation",[python,"eval_models.py","--output",join(output,"model-results.json")],agent);
}
if (suite === "native") {
  await run("Windows Rust tests",npm("run","desktop:test"));
  if (await run("Windows desktop build",npm("run","desktop:build","--","--debug","--no-bundle"))) {
    await run("Windows WebView2 journeys",[process.execPath,"tests/desktop-smoke.mjs"]);
  } else stages.push({name:"Windows WebView2 journeys",status:"skipped",reason:"Desktop build failed"});
}
if (hosting) await run("Public Hosting verification",[process.execPath,"scripts/verify-hosting.mjs",hosting]);

const passed = stages.every(stage => stage.status === "passed");
await mkdir(output,{recursive:true});
await writeFile(join(output,"results.json"),JSON.stringify({suite,passed,completedAt:new Date().toISOString(),stages},null,2) + "\n");
console.log("\nEvaluation results written to " + join(output,"results.json"));
process.exitCode = passed ? 0 : 1;
