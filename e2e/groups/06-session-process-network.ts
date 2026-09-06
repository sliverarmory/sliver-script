import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import dgram from "node:dgram";
import { once } from "node:events";
import { access, realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { SessionRegistryWriteValue, sliverpb } from "../../lib";
import type { E2ESuiteContext, LiveImplant } from "../context";

export const name = "06-session-process-network";

const RPC_TIMEOUT_SECONDS = 120;
const NETWORK_FIXTURE_SETUP_TIMEOUT_MS = 15_000;

interface NetworkFixture {
  readonly server: net.Server;
  readonly accepted: net.Socket;
  readonly client: net.Socket;
  readonly udp: dgram.Socket;
  readonly listenPort: number;
  readonly clientPort: number;
  readonly udpPort: number;
}

export async function run(context: E2ESuiteContext): Promise<void> {
  const implant = requireSession(context);
  const sessionId = implant.session!.ID;

  await verifyInteractiveFacade(context, implant);
  await verifyInterfaces(context, sessionId);
  await verifyNetstat(context, sessionId);
  await verifyMounts(context, sessionId);
  await verifyProcesses(context, implant);
  await verifyExecution(context, implant);

  if (process.platform === "linux") await verifyLinuxMemfiles(context, sessionId);
  if (process.platform === "win32") await verifyWindowsOperations(context, sessionId);
}

async function verifyInteractiveFacade(context: E2ESuiteContext, implant: LiveImplant): Promise<void> {
  const commands = context.client.interactSession(implant.session!.ID);
  const processes = await commands.ps(false, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(processes, "interactive session process inventory");
  assert.ok(
    processes.Processes.some((candidate) => candidate.Pid === implant.pid),
    "interactive session process inventory must contain the implant",
  );

  const interfaces = await commands.ifconfig(RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(interfaces, "interactive session ifconfig");
  assert.ok(interfaces.NetInterfaces.length > 0, "interactive session interfaces");

  const sockets = await commands.netstat(RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(sockets, "interactive session netstat");
  assert.ok(Array.isArray(sockets.Entries), "interactive session socket entries");

  const helperPath = path.join(__dirname, "..", "exec-helper.js");
  await access(helperPath);
  const executed = await commands.execute(process.execPath, [helperPath], true, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(executed, "interactive session execute");
  assert.equal(executed.Status, 64, "interactive session helper default exit status");
  assert.match(executed.Stderr.toString(), /unsupported helper mode/u, "interactive session helper stderr");
}

async function verifyInterfaces(context: E2ESuiteContext, sessionId: string): Promise<void> {
  const response = await context.client.ifconfigSession(sessionId, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(response, "session ifconfig");
  assert.ok(response.NetInterfaces.length > 0, "network interface inventory must not be empty");
  for (const networkInterface of response.NetInterfaces) {
    assert.ok(networkInterface.Name.trim(), "network interface name");
    for (const address of networkInterface.IPAddresses) {
      assert.ok(parseAddress(address), `parseable interface address ${address}`);
    }
  }
  assert.ok(
    response.NetInterfaces.some((networkInterface) => networkInterface.IPAddresses.some(isLoopbackAddress)),
    "network interface inventory must contain loopback",
  );
}

async function verifyNetstat(context: E2ESuiteContext, sessionId: string): Promise<void> {
  const fixture = await createNetworkFixture();
  try {
    const variants = [
      {
        label: "TCP IPv4 listening",
        options: { tcp: true, udp: false, ip4: true, ip6: false, listening: true },
        port: fixture.listenPort,
        protocol: "tcp",
        state: "LISTEN",
      },
      {
        label: "TCP IPv4 established",
        options: { tcp: true, udp: false, ip4: true, ip6: false, listening: false },
        port: fixture.clientPort,
        protocol: "tcp",
        state: "ESTABLISHED",
      },
      {
        label: "UDP IPv4",
        options: { tcp: false, udp: true, ip4: true, ip6: false, listening: false },
        port: fixture.udpPort,
        protocol: "udp",
        state: "",
      },
    ] as const;

    for (const variant of variants) {
      const response = await context.client.netstatSession(
        sessionId,
        variant.options,
        RPC_TIMEOUT_SECONDS,
      );
      assertImplantSuccess(response, `session netstat ${variant.label}`);
      assert.ok(
        response.Entries.some((entry) => socketMatches(entry, variant.port, variant.protocol, variant.state)),
        `${variant.label} fixture socket must be present on port ${variant.port}`,
      );
    }
  } finally {
    await closeNetworkFixture(fixture);
  }
}

async function verifyMounts(context: E2ESuiteContext, sessionId: string): Promise<void> {
  const response = await context.client.mountsSession(sessionId, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(response, "session mounts");
  assert.ok(response.Info.length > 0, "mount inventory must not be empty");
  assert.ok(
    response.Info.some((mount) => mount.MountPoint.trim() || mount.VolumeName.trim()),
    "mount inventory must contain an identified mount",
  );
}

async function verifyProcesses(context: E2ESuiteContext, implant: LiveImplant): Promise<void> {
  const sessionId = implant.session!.ID;
  for (const fullInfo of [false, true]) {
    const response = await context.client.psSession(sessionId, fullInfo, RPC_TIMEOUT_SECONDS);
    assertImplantSuccess(response, `session process inventory fullInfo=${fullInfo}`);
    const processInfo = response.Processes.find((candidate) => candidate.Pid === implant.pid);
    assert.ok(processInfo, `process inventory must contain implant PID ${implant.pid}`);
    if (fullInfo) {
      assert.ok(processInfo.Executable.trim(), "full process inventory executable");
      if (processInfo.Architecture.trim()) {
        assert.equal(
          normalizeArchitecture(processInfo.Architecture),
          context.environment.expectedArch,
          "implant process architecture",
        );
      } else {
        assert.equal(context.environment.expectedOS, "darwin", "only macOS may omit process architecture");
      }
    }
  }
}

async function verifyExecution(context: E2ESuiteContext, implant: LiveImplant): Promise<void> {
  const sessionId = implant.session!.ID;
  const helperPath = path.join(__dirname, "..", "exec-helper.js");
  await access(helperPath);
  const marker = `session-${process.pid}-${Date.now().toString(36)}`;

  const synchronous = await context.client.executeSession(
    sessionId,
    {
      path: process.execPath,
      args: [helperPath],
      output: true,
      envInheritance: true,
      env: {
        SLIVER_E2E_HELPER: "sync",
        SLIVER_E2E_EXEC_MARKER: marker,
      },
    },
    RPC_TIMEOUT_SECONDS,
  );
  assertImplantSuccess(synchronous, "session synchronous execute");
  assert.equal(synchronous.Status, 7, "synchronous execute exit status");
  assert.ok(synchronous.Stdout.toString().includes(`stdout:${marker}`), "synchronous execute stdout marker");
  assert.ok(synchronous.Stderr.toString().includes(`stderr:${marker}`), "synchronous execute stderr marker");

  let ownedChildPid: number | undefined;
  try {
    const background = await context.client.executeSession(
      sessionId,
      {
        path: process.execPath,
        args: [helperPath],
        background: true,
        envInheritance: true,
        env: {
          SLIVER_E2E_HELPER: "child",
          SLIVER_E2E_EXEC_MARKER: marker,
        },
      },
      RPC_TIMEOUT_SECONDS,
    );
    assertImplantSuccess(background, "session background execute");
    assert.ok(background.Pid > 1, "background execute PID");
    ownedChildPid = background.Pid;

    const child = await requireOwnedLiveChild(context, sessionId, ownedChildPid, helperPath);
    assert.equal(child.Exited, false, "tracked helper must initially be live");

    // Reconcile the exact PID, executable, and argument immediately before the
    // only process-termination operation in this test.
    await requireOwnedLiveChild(context, sessionId, ownedChildPid, helperPath);
    const terminated = await context.client.terminateSessionProcess(
      sessionId,
      ownedChildPid,
      false,
      RPC_TIMEOUT_SECONDS,
    );
    assertImplantSuccess(terminated, "session terminate helper");
    assert.equal(terminated.Pid, ownedChildPid, "terminated helper PID");

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const children = await context.client.executeChildrenSession(sessionId, RPC_TIMEOUT_SECONDS);
      assertImplantSuccess(children, "session execute children after terminate");
      const tracked = children.Children.find((candidate) => candidate.Pid === ownedChildPid);
      if (tracked?.Exited) {
        ownedChildPid = undefined;
        return;
      }
      await delay(250);
    }
    throw new Error(`tracked helper PID ${ownedChildPid} was not recorded as exited`);
  } finally {
    if (ownedChildPid !== undefined) {
      const child = await findOwnedChild(context, sessionId, ownedChildPid, helperPath);
      if (child && !child.Exited) {
        const terminated = await context.client.terminateSessionProcess(
          sessionId,
          ownedChildPid,
          false,
          RPC_TIMEOUT_SECONDS,
        );
        assertImplantSuccess(terminated, "cleanup session helper process");
      }
    }
  }
}

async function verifyLinuxMemfiles(context: E2ESuiteContext, sessionId: string): Promise<void> {
  let ownedFd: string | undefined;
  try {
    const added = await context.client.memfilesAddSession(sessionId, RPC_TIMEOUT_SECONDS);
    assertImplantSuccess(added, "session memfile add");
    assert.ok(/^\d+$/u.test(added.Fd) && BigInt(added.Fd) >= 3n, "created memfile descriptor");
    ownedFd = added.Fd;

    const listed = await context.client.memfilesListSession(sessionId, RPC_TIMEOUT_SECONDS);
    assertImplantSuccess(listed, "session memfile list");
    assert.ok(
      listed.Files.some((file) => file.Name === ownedFd && file.Link.includes("memfd:")),
      `created memfile ${ownedFd} must be listed`,
    );

    const removed = await context.client.memfilesRmSession(sessionId, ownedFd, RPC_TIMEOUT_SECONDS);
    assertImplantSuccess(removed, "session memfile remove");
    assert.equal(removed.Fd, ownedFd, "removed memfile descriptor");
    ownedFd = undefined;

    const afterRemove = await context.client.memfilesListSession(sessionId, RPC_TIMEOUT_SECONDS);
    assertImplantSuccess(afterRemove, "session memfile list after remove");
    assert.equal(
      afterRemove.Files.some((file) => file.Name === removed.Fd),
      false,
      "removed memfile must not be listed",
    );
  } finally {
    if (ownedFd !== undefined) {
      const removed = await context.client.memfilesRmSession(sessionId, ownedFd, RPC_TIMEOUT_SECONDS);
      assertImplantSuccess(removed, "cleanup session memfile");
    }
  }
}

async function verifyWindowsOperations(context: E2ESuiteContext, sessionId: string): Promise<void> {
  const owner = await context.client.currentTokenOwnerSession(sessionId, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(owner, "session current token owner");
  assert.ok(owner.Output.trim(), "current token owner must not be empty");

  const privileges = await context.client.getPrivsSession(sessionId, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(privileges, "session privilege inventory");
  assert.ok(privileges.ProcessName.trim(), "privilege inventory process name");
  assert.ok(privileges.PrivInfo.length > 0, "privilege inventory entries");

  const services = await context.client.servicesSession(sessionId, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(services, "session service inventory");
  assert.ok(services.Details.length > 0, `service inventory entries (warning: ${services.Error})`);
  const selected = services.Details.find((service) => service.Name.toLowerCase() === "eventlog");
  assert.ok(selected, `service inventory must contain EventLog (warning: ${services.Error})`);

  const detail = await context.client.serviceDetailSession(sessionId, selected.Name, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(detail, "session service detail");
  assert.ok(detail.Detail, "service detail payload");
  assert.equal(detail.Detail.Name.toLowerCase(), selected.Name.toLowerCase(), "service detail name");
  assert.equal(detail.Detail.DisplayName, selected.DisplayName, "service detail display name");
  assert.ok(detail.Detail.BinPath.trim(), "service detail binary path");

  await verifyWindowsRegistry(context, sessionId);
}

async function verifyWindowsRegistry(context: E2ESuiteContext, sessionId: string): Promise<void> {
  const hive = "HKCU";
  const parentPath = "Software";
  const fixtureName = `SliverScriptE2E-${randomUUID().replaceAll("-", "")}`;
  const fixturePath = `${parentPath}\\${fixtureName}`;
  const childName = "nested";
  let rootMayExist = false;

  const values: ReadonlyArray<{
    readonly name: string;
    readonly value: SessionRegistryWriteValue;
    readonly expected: string;
  }> = [
    { name: "string-value", value: { type: "string", value: `sliver-script-e2e-${fixtureName}` }, expected: `sliver-script-e2e-${fixtureName}` },
    { name: "binary-value", value: { type: "binary", value: Buffer.from([0x00, 0x7f, 0x80, 0xff]) }, expected: "[0 127 128 255]" },
    { name: "dword-value", value: { type: "dword", value: 0x5a17c0de }, expected: "0x5a17c0de" },
    { name: "qword-value", value: { type: "qword", value: "81985529216486895" }, expected: "0x123456789abcdef" },
  ];

  try {
    rootMayExist = true;
    const root = await context.client.registryCreateKeySession(
      sessionId,
      hive,
      parentPath,
      fixtureName,
      RPC_TIMEOUT_SECONDS,
    );
    assertImplantSuccess(root, "session registry create fixture root");
    const child = await context.client.registryCreateKeySession(
      sessionId,
      hive,
      fixturePath,
      childName,
      RPC_TIMEOUT_SECONDS,
    );
    assertImplantSuccess(child, "session registry create fixture child");

    for (const value of values) {
      const written = await context.client.registryWriteSession(
        sessionId,
        hive,
        fixturePath,
        value.name,
        value.value,
        RPC_TIMEOUT_SECONDS,
      );
      assertImplantSuccess(written, `session registry write ${value.name}`);
    }

    for (const value of values) {
      const read = await context.client.registryReadSession(
        sessionId,
        hive,
        fixturePath,
        value.name,
        RPC_TIMEOUT_SECONDS,
      );
      assertImplantSuccess(read, `session registry read ${value.name}`);
      assert.equal(read.Value, value.expected, `session registry value ${value.name}`);
    }

    const subkeys = await context.client.registryListSubkeysSession(
      sessionId,
      hive,
      fixturePath,
      RPC_TIMEOUT_SECONDS,
    );
    assertImplantSuccess(subkeys, "session registry list subkeys");
    assert.deepEqual([...subkeys.Subkeys].sort(), [childName], "session registry child inventory");

    const listedValues = await context.client.registryListValuesSession(
      sessionId,
      hive,
      fixturePath,
      RPC_TIMEOUT_SECONDS,
    );
    assertImplantSuccess(listedValues, "session registry list values");
    assert.deepEqual(
      [...listedValues.ValueNames].sort(),
      values.map((value) => value.name).sort(),
      "session registry value inventory",
    );

    const deletedChild = await context.client.registryDeleteKeySession(
      sessionId,
      hive,
      fixturePath,
      childName,
      RPC_TIMEOUT_SECONDS,
    );
    assertImplantSuccess(deletedChild, "session registry delete fixture child");
    const deletedRoot = await context.client.registryDeleteKeySession(
      sessionId,
      hive,
      parentPath,
      fixtureName,
      RPC_TIMEOUT_SECONDS,
    );
    assertImplantSuccess(deletedRoot, "session registry delete fixture root");
    await assertRegistryRootAbsent(context, sessionId, hive, parentPath, fixtureName);
    rootMayExist = false;
  } finally {
    if (rootMayExist) {
      await context.client.registryDeleteKeySession(
        sessionId,
        hive,
        fixturePath,
        childName,
        RPC_TIMEOUT_SECONDS,
      ).catch(() => undefined);
      await context.client.registryDeleteKeySession(
        sessionId,
        hive,
        parentPath,
        fixtureName,
        RPC_TIMEOUT_SECONDS,
      ).catch(() => undefined);
      await assertRegistryRootAbsent(context, sessionId, hive, parentPath, fixtureName);
    }
  }
}

async function assertRegistryRootAbsent(
  context: E2ESuiteContext,
  sessionId: string,
  hive: string,
  parentPath: string,
  fixtureName: string,
): Promise<void> {
  const parent = await context.client.registryListSubkeysSession(
    sessionId,
    hive,
    parentPath,
    RPC_TIMEOUT_SECONDS,
  );
  assertImplantSuccess(parent, "verify session registry fixture cleanup");
  assert.equal(parent.Subkeys.includes(fixtureName), false, "registry fixture root must be absent");
}

async function requireOwnedLiveChild(
  context: E2ESuiteContext,
  sessionId: string,
  pid: number,
  helperPath: string,
): Promise<sliverpb.ExecuteChild> {
  const child = await findOwnedChild(context, sessionId, pid, helperPath);
  assert.ok(child, `exact test-owned helper PID ${pid} must be tracked`);
  assert.equal(child.Exited, false, `test-owned helper PID ${pid} must be live`);
  return child;
}

async function findOwnedChild(
  context: E2ESuiteContext,
  sessionId: string,
  pid: number,
  helperPath: string,
): Promise<sliverpb.ExecuteChild | undefined> {
  const response = await context.client.executeChildrenSession(sessionId, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(response, "session execute children");
  const child = response.Children.find((candidate) => candidate.Pid === pid);
  if (!child) return undefined;
  assert.equal(await pathsEqual(child.Path, process.execPath), true, `test-owned helper PID ${pid} executable`);
  assert.equal(child.Args.length, 1, `test-owned helper PID ${pid} argument count`);
  assert.equal(await pathsEqual(child.Args[0] ?? "", helperPath), true, `test-owned helper PID ${pid} script path`);
  return child;
}

async function createNetworkFixture(): Promise<NetworkFixture> {
  const server = net.createServer();
  let accepted: net.Socket | undefined;
  let client: net.Socket | undefined;
  let udp: dgram.Socket | undefined;
  const setupController = new AbortController();
  const setupTimer = setTimeout(() => {
    setupController.abort(new Error("Network fixture setup timed out"));
  }, NETWORK_FIXTURE_SETUP_TIMEOUT_MS);
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening", { signal: setupController.signal });
    const address = server.address();
    assert.ok(address && typeof address !== "string", "TCP fixture listener address");

    const acceptedPromise = waitForTcpConnection(server, setupController.signal).then((socket) => {
      accepted = socket;
    });
    client = new net.Socket();
    const connectedPromise = once(client, "connect", { signal: setupController.signal });
    client.connect(address.port, "127.0.0.1");
    await Promise.all([acceptedPromise, connectedPromise]);
    assert.ok(accepted, "TCP fixture accepted socket");
    const clientAddress = client.address();
    assert.ok(
      typeof clientAddress !== "string" && "port" in clientAddress,
      "TCP fixture client address",
    );

    udp = dgram.createSocket("udp4");
    udp.bind(0, "127.0.0.1");
    await once(udp, "listening", { signal: setupController.signal });
    const udpAddress = udp.address();

    return {
      server,
      accepted,
      client,
      udp,
      listenPort: address.port,
      clientPort: clientAddress.port,
      udpPort: udpAddress.port,
    };
  } catch (error) {
    accepted?.destroy();
    client?.destroy();
    await Promise.allSettled([
      udp ? closeUdpSocket(udp) : Promise.resolve(),
      closeTcpServer(server),
    ]);
    throw error;
  } finally {
    clearTimeout(setupTimer);
  }
}

async function waitForTcpConnection(server: net.Server, signal: AbortSignal): Promise<net.Socket> {
  const [socket] = await once(server, "connection", { signal }) as [net.Socket];
  return socket;
}

async function closeNetworkFixture(fixture: NetworkFixture): Promise<void> {
  fixture.accepted.destroy();
  fixture.client.destroy();
  await Promise.all([
    closeUdpSocket(fixture.udp),
    closeTcpServer(fixture.server),
  ]);
}

async function closeUdpSocket(socket: dgram.Socket): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function closeTcpServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function socketMatches(
  entry: sliverpb.SockTabEntry,
  port: number,
  protocol: string,
  state: string,
): boolean {
  if (entry.Protocol.toLowerCase() !== protocol.toLowerCase()) return false;
  if (state && entry.SkState.toLowerCase() !== state.toLowerCase()) return false;
  return entry.LocalAddr?.Port === port || entry.RemoteAddr?.Port === port;
}

function parseAddress(rawAddress: string): string | undefined {
  let address = rawAddress.trim();
  const slash = address.indexOf("/");
  if (slash >= 0) address = address.slice(0, slash);
  address = address.replace(/^\[|\]$/gu, "");
  const zone = address.lastIndexOf("%");
  if (zone >= 0) address = address.slice(0, zone);
  return net.isIP(address) ? address : undefined;
}

function isLoopbackAddress(rawAddress: string): boolean {
  const address = parseAddress(rawAddress)?.toLowerCase();
  return address?.startsWith("127.") === true
    || address === "::1"
    || address === "0:0:0:0:0:0:0:1";
}

function normalizeArchitecture(architecture: string): string {
  switch (architecture.trim().toLowerCase()) {
    case "386":
    case "i386":
    case "i686":
    case "x86":
      return "386";
    case "amd64":
    case "x86_64":
    case "x64":
      return "amd64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      return architecture.trim().toLowerCase();
  }
}

async function pathsEqual(left: string, right: string): Promise<boolean> {
  const normalize = async (candidate: string): Promise<string> => {
    let normalized = path.resolve(candidate);
    try {
      normalized = await realpath(normalized);
    } catch {
      // Leave a missing path normalized lexically for diagnostic assertions.
    }
    normalized = path.normalize(normalized);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return await normalize(left) === await normalize(right);
}

function requireSession(context: E2ESuiteContext): LiveImplant {
  assert.ok(context.session, "listener/generation group must launch a session first");
  assert.ok(context.session.session, "session callback metadata is required");
  assert.ok(context.session.session.ID, "session callback ID is required");
  return context.session;
}

function assertImplantSuccess(
  response: { readonly Response?: { readonly Err: string } },
  label: string,
): void {
  assert.equal(response.Response?.Err ?? "", "", `${label} implant error`);
}
