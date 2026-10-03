import { runCli } from "./init.js";

process.exitCode = await runCli(process.argv.slice(2));
