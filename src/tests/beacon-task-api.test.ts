import {
  BeaconTaskIdentityError,
  OperationAbortedError,
  SliverClient,
  clientpb,
  sliverpb,
  type SliverClientConfig,
} from "../index";

const taskId = "task-api";
const beaconId = "beacon-api";

function metadata(overrides: Partial<clientpb.BeaconTask> = {}): clientpb.BeaconTask {
  return clientpb.BeaconTask.create({
    ID: taskId,
    BeaconID: beaconId,
    State: "completed",
    Response: Buffer.from(sliverpb.Ping.encode(sliverpb.Ping.create({ Nonce: 91 })).finish()),
    ...overrides,
  });
}

function clientWithRpc(clients: Record<string, object>) {
  const config: SliverClientConfig = {
    operator: "beacon-task-test", token: "fixture-token", lhost: "localhost", lport: 31337,
    ca_certificate: "", certificate: "", private_key: "",
  };
  const client = new SliverClient(config);
  const internals = client as unknown as { rpcClients: Record<string, object | undefined> };
  Object.assign(internals.rpcClients, clients);
  return { client, clients: internals.rpcClients };
}

afterEach(() => jest.useRealTimers());

test("SliverClient task handles use replacement task-content channels after reconnect", async () => {
  jest.useFakeTimers();
  const initial = {
    getBeaconTaskContent: jest.fn(async () => metadata({ State: "pending", Response: Buffer.alloc(0) })),
  };
  const replacement = { getBeaconTaskContent: jest.fn(async () => metadata()) };
  const { client, clients } = clientWithRpc({ "task-content": initial });
  const handle = client.beaconTask(taskId, sliverpb.Ping, { beaconId });
  const waiting = handle.wait({ timeoutSeconds: 5 });
  await jest.advanceTimersByTimeAsync(0);
  delete clients["task-content"];
  await jest.advanceTimersByTimeAsync(1_000);
  clients["task-content"] = replacement;
  await jest.advanceTimersByTimeAsync(1_000);

  await expect(waiting).resolves.toMatchObject({ Nonce: 91 });
  expect(initial.getBeaconTaskContent).toHaveBeenCalledTimes(1);
  expect(replacement.getBeaconTaskContent).toHaveBeenCalledTimes(1);
  await expect(handle.status(3)).resolves.toMatchObject({ State: "completed" });
  await expect(client.beaconTask(taskId, sliverpb.Ping).wait(3)).resolves.toMatchObject({ Nonce: 91 });
  expect(jest.getTimerCount()).toBe(0);
});

test("SliverClient handle cancellation uses only the artifact channel", async () => {
  const controlCancel = jest.fn();
  const contentCancel = jest.fn();
  const artifactCancel = jest.fn(async () => metadata({ State: "canceled", Response: Buffer.alloc(0) }));
  const { client } = clientWithRpc({
    control: { cancelBeaconTask: controlCancel },
    "task-content": { cancelBeaconTask: contentCancel },
    artifact: { cancelBeaconTask: artifactCancel },
  });
  await expect(client.beaconTask(taskId, sliverpb.Ping, { beaconId }).cancel(4))
    .resolves.toMatchObject({ ID: taskId, State: "canceled" });
  expect(artifactCancel).toHaveBeenCalledWith({ ID: taskId }, { signal: expect.any(AbortSignal) });
  expect(controlCancel).not.toHaveBeenCalled();
  expect(contentCancel).not.toHaveBeenCalled();
});

test("InteractiveBeacon binds handles to its own beacon identity", async () => {
  const getBeaconTaskContent = jest.fn(async () => metadata({ BeaconID: "different-beacon" }));
  const { client } = clientWithRpc({ control: {}, artifact: {}, "task-content": { getBeaconTaskContent } });
  const handle = client.interactBeacon(beaconId).beaconTask(taskId, sliverpb.Ping);
  await expect(handle.wait(2)).rejects.toBeInstanceOf(BeaconTaskIdentityError);
  await expect(handle.status(2)).rejects.toBeInstanceOf(BeaconTaskIdentityError);
});

test("legacy numeric lsTask calls retain wait and gain status and cancellation", async () => {
  const ls = jest.fn(async () => sliverpb.Ls.create({
    Response: { Async: true, TaskID: taskId, BeaconID: beaconId, Err: "" },
  }));
  const response = metadata({
    Response: Buffer.from(sliverpb.Ls.encode(sliverpb.Ls.create({ Path: "/fixture", Exists: true })).finish()),
  });
  const getBeaconTaskContent = jest.fn(async () => response);
  const cancelBeaconTask = jest.fn(async () => metadata({ State: "canceled", Response: Buffer.alloc(0) }));
  const { client } = clientWithRpc({
    control: { ls }, artifact: { cancelBeaconTask }, "task-content": { getBeaconTaskContent },
  });
  const handle = await client.interactBeacon(beaconId).lsTask("/fixture", 7);
  expect(handle.id).toBe(taskId);
  expect(ls).toHaveBeenCalledWith({
    Path: "/fixture",
    Request: { Async: true, Timeout: "6999999999", BeaconID: beaconId, SessionID: "" },
  }, { signal: expect.any(AbortSignal) });
  await expect(handle.wait(7)).resolves.toMatchObject({ Path: "/fixture", Exists: true });
  await expect(handle.status(7)).resolves.toMatchObject({ ID: taskId, State: "completed" });
  await expect(handle.cancel(7)).resolves.toMatchObject({ ID: taskId, State: "canceled" });
  expect(cancelBeaconTask).toHaveBeenCalledTimes(1);
});

test("canceling a public handle's local wait leaves another wait and remote task intact", async () => {
  jest.useFakeTimers();
  let complete = false;
  const getBeaconTaskContent = jest.fn(async () => complete
    ? metadata()
    : metadata({ State: "pending", Response: Buffer.alloc(0) }));
  const cancelBeaconTask = jest.fn();
  const { client } = clientWithRpc({ "task-content": { getBeaconTaskContent }, artifact: { cancelBeaconTask } });
  const handle = client.beaconTask(taskId, sliverpb.Ping, { beaconId });
  const controller = new AbortController();
  const abandoned = handle.wait({ signal: controller.signal });
  const rejected = expect(abandoned).rejects.toBeInstanceOf(OperationAbortedError);
  const retained = handle.wait(5);
  await jest.advanceTimersByTimeAsync(0);
  controller.abort();
  await rejected;
  complete = true;
  await jest.advanceTimersByTimeAsync(1_000);
  await expect(retained).resolves.toMatchObject({ Nonce: 91 });
  expect(cancelBeaconTask).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
