const mode = process.env.SLIVER_E2E_HELPER ?? "";
const marker = process.env.SLIVER_E2E_EXEC_MARKER ?? "missing-marker";

switch (mode) {
  case "sync":
    process.stdout.write(`stdout:${marker}\n`);
    process.stderr.write(`stderr:${marker}\n`);
    process.exitCode = 7;
    break;
  case "child": {
    process.stdout.write(`child:${marker}\n`);
    const ownerPid = process.ppid;
    let exited = false;
    const exit = (): void => {
      if (exited) return;
      exited = true;
      clearInterval(parentWatcher);
      clearTimeout(hardStop);
      process.exit(0);
    };
    const parentWatcher = setInterval(() => {
      if (process.ppid !== ownerPid) exit();
    }, 1_000);
    const hardStop = setTimeout(exit, 15 * 60_000);
    process.once("SIGINT", exit);
    process.once("SIGTERM", exit);
    break;
  }
  default:
    process.stderr.write(`unsupported helper mode:${mode}\n`);
    process.exitCode = 64;
}
