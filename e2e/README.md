# End-to-end tests

The E2E suite builds the native Sliver server from the repository's pinned
`sliver` submodule, starts that binary with isolated state, and uses its CLI to
create a direct-mTLS multiplayer operator profile on `127.0.0.1`. The compiled
`sliver-script` library authenticates with that profile and controls the real
server, a generated session implant, and a generated beacon implant.

All groups run sequentially in one stateful suite. This lets the expensive
listener and implant setup in group 03 feed the session and beacon groups while
keeping each area of client behavior independently identifiable in diagnostics.

| Group | Coverage |
| --- | --- |
| `00-connectivity` | Profile parsing, authenticated/idempotent client lifecycle, exact Sliver commit and native platform provenance, operator identity, event-stream state, and derived client join/leave events |
| `01-inventory` | Empty fresh-server session, beacon, and managed-job inventories through raw and convenience APIs |
| `02-server-data` | Compiler, encoder, canary, and WireGuard-IP discovery plus implant-profile, loot, credential, and website-content CRUD |
| `03-listener-generation-callbacks` | Loopback mTLS listener start/job event, native session and 10-second beacon generation, regeneration/staging, real process launch, exact raw and derived callback events, target metadata, and build inventory |
| `04-session-core` | Session inventory, direct and interactive ping, rename/restore, and environment read/set/unset |
| `05-session-filesystem` | Working-directory changes, directory listing and globbing, upload/download ranges, recursive archives and grep, copy/move/timestamps/removal, and Unix permission/ownership calls |
| `06-session-process-network` | Interfaces, live TCP/UDP socket inventory, mounts, basic/full process inventory, synchronous/background execution, child tracking and termination, Linux memfiles, and Windows token/privilege/service reads plus isolated HKCU registry CRUD |
| `07-beacon-core` | Beacon metadata and rename, direct and interactive queued pings, derived task-result events, 10-second reconfiguration, task cancellation, fetch, and history/count reconciliation |
| `08-beacon-filesystem` | Queued working-directory, mkdir, cd, upload/download, list, and recursive removal calls with completed-task verification |
| `09-beacon-process-network` | Queued process, interface, socket, and environment calls plus synchronous/background execution, child tracking, termination, and task-history verification |
| `10-beacon-session-transition` | Opening an mTLS session from the live beacon, callback correlation, ping/close, and confirmation that the beacon remains registered |
| `11-lifecycle-cleanup` | Session and beacon kill semantics, disconnect/job-stop events, process exit, beacon removal, generated-build deletion, listener stop, and terminal empty inventories |

Run the full suite from the repository root:

```sh
npm run test:e2e
```

Select a comma-separated subset with `SLIVER_E2E_GROUPS`:

```sh
SLIVER_E2E_GROUPS=02-server-data,04-session-core npm run test:e2e
```

On PowerShell, set the same variable before invoking npm:

```powershell
$env:SLIVER_E2E_GROUPS = "02-server-data,04-session-core"
npm run test:e2e
```

Groups 04 through 11 depend on the live targets created by group 03. The outer
runner automatically adds `03-listener-generation-callbacks` when any of those
groups is selected, then runs the selected groups in numeric order. Groups 00
through 02 can run independently. An unknown group name fails before server
startup.

The first run may download Sliver's compiler assets and can take substantially
longer than a warm run. The asset stamp ties cached files to both the pinned
Sliver commit and required Go version. The harness rejects non-ignored source
changes in the submodule or a native OS/architecture mismatch.

Set `SLIVER_E2E_RESULTS_DIR` to retain local diagnostics outside the temporary
test root:

```sh
SLIVER_E2E_RESULTS_DIR=e2e-results/local npm run test:e2e
```

Diagnostics include `summary.json`, `group-results.json`, `suite.log`, one log
per attempted group, captured daemon output, and the bounded Sliver log when it
exists. GitHub Actions uploads the platform result directory for 14 days even
when a group fails.

The suite confines server state, generated binaries, target homes, temporary
files, registry writes, and filesystem mutations to per-run fixtures. Implants
receive a minimal environment, use only loopback mTLS, and operate on sentinel-
guarded test trees; process termination targets only helper processes spawned by
the suite. The server and operator CLI also receive an allowlisted environment
so diagnostic logs do not inherit unrelated CI secrets. Generated binary bytes
are cleared after being written, and failure cleanup removes profiles, builds,
listeners, sessions, beacons, processes, and the temporary root.

The suite does not run shell/tunnel interaction, screenshots, process dumps,
service mutation, token mutation, registry-hive export, injection, or arbitrary
payload execution. Those calls require separate fixtures or privileges and are
kept outside this portable localhost matrix.

GitHub Actions runs the full suite with a recursive submodule checkout, Node.js
24.20.0/npm 11.19.0, and the Go version declared by `sliver/go.mod` on:

| Platform | Runner |
| --- | --- |
| `linux/amd64` | `ubuntu-24.04` |
| `windows/amd64` | `windows-2025` |
| `darwin/arm64` | `macos-15` |
