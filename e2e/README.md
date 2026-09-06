# End-to-end tests

These tests compile the pinned `sliver` submodule into a native server, use that
binary's CLI to create an isolated direct-mTLS multiplayer operator profile,
start the daemon on loopback, and connect with the compiled `sliver-script`
library. The operator profile and server state live in a temporary directory and
are never written to test artifacts.

Run every implemented group with:

```sh
npm run test:e2e
```

Set `SLIVER_E2E_GROUPS=00-connectivity` to run a comma-separated subset. The
initial implementation has these groups:

| Group | Coverage |
| --- | --- |
| `00-connectivity` | Profile parsing, authenticated connection, server version/provenance, native OS/architecture, operator identity, disconnect cleanup |
| `01-inventory` | Empty fresh-server session and beacon inventories, job inventory, and high-level wrapper response shapes |

The remaining client functionality is divided into future groups so each can be
added without expanding one monolithic scenario:

| Planned group | Intended coverage |
| --- | --- |
| `02-events-jobs` | Event stream state plus listener start/list/stop reconciliation |
| `03-builds-profiles` | Compiler inventory, implant profile lifecycle, generation, staging, regeneration, and deletion |
| `04-websites-artifacts` | Website/content CRUD and bounded artifact transfers |
| `05-loot-credentials` | Loot and credential CRUD, lookup, content, and validation |
| `06-sessions` | Real session registration, process/filesystem/network RPCs, tunnels, shell, and teardown |
| `07-beacons` | Real beacon registration, queued task/result lifecycle, cancellation, and teardown |
| `08-transports` | mTLS, HTTP(S), DNS, and WireGuard listener/implant matrices |
| `09-extensions` | Extensions, aliases, WASM, traffic encoders, and related artifact paths |
| `10-admin-integrations` | Builders, crackstations, monitoring, hosts, certificates, and other server integrations |

The basic groups use a full Sliver asset bundle even though they do not generate
implants yet. This keeps the server binary and startup path identical to later
groups. GitHub Actions caches those ignored build inputs per runner platform.
