import { of, Subject } from "rxjs";

import { SliverClient, InteractiveBeacon, InteractiveSession } from "../client";
import type { SliverClientConfig } from "../config";
import {
  BeaconTask,
  Event,
  type GenerateSpoofMetadataReq,
  ListenerJob,
  Operators,
  Sessions,
  Session,
  KillJob,
  Loot,
  WebContent,
} from "../pb/clientpb/client";
import { Empty } from "../pb/commonpb/common";
import { Ls } from "../pb/sliverpb/sliver";
import { RPC_MESSAGE_BUDGETS } from "../messageBudget";

function dummyConfig(): SliverClientConfig {
  return {
    operator: "test",
    token: "token",
    lhost: "localhost",
    lport: 31337,
    ca_certificate: "",
    certificate: "",
    private_key: "",
  };
}

test("SliverClient.sessions() forwards to rpc.getSessions()", async () => {
  const getSessions = jest.fn(async (_req: unknown, _options?: unknown) =>
    Sessions.create({
      Sessions: [Session.create({ ID: "s-1" })],
    }),
  );

  const client = new SliverClient(dummyConfig());
  (client as any).rpcClients.inventory = { getSessions };

  const sessions = await client.sessions(5);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].ID).toBe("s-1");

  expect(getSessions).toHaveBeenCalledTimes(1);
  expect(getSessions.mock.calls[0][0]).toEqual({});
  expect(getSessions.mock.calls[0][1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

test("SliverClient.getOperators() forwards to rpc.getOperators()", async () => {
  const getOperators = jest.fn(async () =>
    Operators.create({
      Operators: [{ Online: true, Name: "op" }],
    }),
  );

  const client = new SliverClient(dummyConfig());
  (client as any).rpcClients.control = { getOperators };

  const operators = await client.operators(5);
  expect(operators[0].Name).toBe("op");
  expect(getOperators).toHaveBeenCalledTimes(1);
});

test("SliverClient.startMTLSListener() forwards to rpc.startMTLSListener()", async () => {
  const startMTLSListener = jest.fn(async () => ListenerJob.create({ ID: "listener", JobID: 1 }));

  const client = new SliverClient(dummyConfig());
  (client as any).rpcClients.control = { startMTLSListener };

  const job = await client.startMTLSListener("127.0.0.1", 4444, 5);
  expect(job.ID).toBe("listener");
  expect(startMTLSListener).toHaveBeenCalledWith(
    { Host: "127.0.0.1", Port: 4444 },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

test("SliverClient.killJob() forwards to rpc.killJob()", async () => {
  const killJob = jest.fn(async () => KillJob.create({ ID: 7, Success: true }));

  const client = new SliverClient(dummyConfig());
  (client as any).rpcClients.control = { killJob };

  const res = await client.killJob(7, 5);
  expect(res.Success).toBe(true);
  expect(killJob).toHaveBeenCalledWith({ ID: 7 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

test("SliverClient.lootRemove() forwards to rpc.lootRm()", async () => {
  const lootRm = jest.fn(async () => Empty.create({}));

  const client = new SliverClient(dummyConfig());
  (client as any).rpcClients.control = { lootRm };

  await client.lootRemove("loot-1", 5);
  expect(lootRm).toHaveBeenCalledWith({ ID: "loot-1" } as Loot, expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

test("SliverClient.websiteUpdateContent() forwards to rpc.websiteUpdateContent()", async () => {
  const websiteUpdateContent = jest.fn(async () => ({ ID: "w", Name: "w", Contents: {} }));

  const client = new SliverClient(dummyConfig());
  (client as any).rpcClients.artifact = { websiteUpdateContent };

  const wc: WebContent = {
    ID: "c",
    WebsiteID: "w",
    Path: "/index.html",
    ContentType: "text/html",
    Size: "0",
    OriginalFile: "",
    Sha256: "",
    Content: Buffer.from("hi"),
  };

  await client.websiteUpdateContent("w", { "/index.html": wc }, 5);
  expect(websiteUpdateContent).toHaveBeenCalledWith(
    { Name: "w", Contents: { "/index.html": wc } },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

test("mutation RPCs with large responses use the artifact channel", async () => {
  const taskBytes = Buffer.alloc(RPC_MESSAGE_BUDGETS.control.maxReceiveBytes + 1, 0x41);
  const websiteBytes = Buffer.alloc(RPC_MESSAGE_BUDGETS.control.maxReceiveBytes + 1, 0x42);
  const returnedTask = BeaconTask.create({ ID: "task-large", Request: taskBytes });
  const returnedWebsite = {
    ID: "website-large",
    Name: "website-large",
    Contents: {
      "/remaining.bin": WebContent.create({ Path: "/remaining.bin", Content: websiteBytes }),
    },
  };
  const control = {
    cancelBeaconTask: jest.fn(),
    websiteRemoveContent: jest.fn(),
  };
  const artifact = {
    cancelBeaconTask: jest.fn(async () => returnedTask),
    websiteRemoveContent: jest.fn(async () => returnedWebsite),
  };
  const client = new SliverClient(dummyConfig());
  Object.assign((client as any).rpcClients, { control, artifact });

  try {
    await expect(client.cancelBeaconTask("task-large", 0)).resolves.toBe(returnedTask);
    await expect(client.websiteRemoveContent("website-large", ["/removed.bin"], 0))
      .resolves.toBe(returnedWebsite);
    expect(artifact.cancelBeaconTask).toHaveBeenCalledWith(
      { ID: "task-large" },
      { signal: expect.any(AbortSignal) },
    );
    expect(artifact.websiteRemoveContent).toHaveBeenCalledWith(
      { Name: "website-large", Paths: ["/removed.bin"] },
      { signal: expect.any(AbortSignal) },
    );
    expect(control.cancelBeaconTask).not.toHaveBeenCalled();
    expect(control.websiteRemoveContent).not.toHaveBeenCalled();
  } finally {
    taskBytes.fill(0);
    websiteBytes.fill(0);
  }
});

test("SliverClient.generateSpoofMetadata() forwards to rpc.generateSpoofMetadata()", async () => {
  const generateSpoofMetadata = jest.fn(async () => Empty.create({}));

  const client = new SliverClient(dummyConfig());
  (client as any).rpcClients.artifact = { generateSpoofMetadata };

  const req: GenerateSpoofMetadataReq = {
    ImplantBuildID: "build-1",
    ImplantName: "implant-1",
    ResourceID: "42",
  };

  await client.generateSpoofMetadata(req, 5);
  expect(generateSpoofMetadata).toHaveBeenCalledWith(
    req,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

test("InteractiveBeacon.lsTask().wait() decodes beacon task results", async () => {
  const taskId = "task-1";
  const beaconId = "beacon-1";

  const events$ = new Subject<Event>();

  const lsRespBytes = Buffer.from(Ls.encode(Ls.create({ Path: "/tmp", Exists: true })).finish());

  const rpc = {
    ls: jest.fn(async () =>
      Ls.create({
        Response: { Err: "", Async: true, BeaconID: beaconId, TaskID: taskId },
      }),
    ),
    getBeaconTaskContent: jest.fn(async () =>
      BeaconTask.create({
        ID: taskId,
        Response: lsRespBytes,
      }),
    ),
  };

  // Preserve the v1 constructor while SliverClient-created wrappers use the
  // dedicated artifact and task-content clients.
  const beacon = new InteractiveBeacon(rpc as any, events$.asObservable(), beaconId);
  const task = await beacon.lsTask(".", 5);

  const wait = task.wait(5);

  // Emit a taskresult event that includes the task id after wait() has subscribed.
  events$.next({
    EventType: SliverClient.EVENT_BEACON_TASKRESULT,
    Data: Buffer.from(BeaconTask.encode(BeaconTask.create({ ID: taskId })).finish()),
    Err: "",
  });

  const ls = await wait;
  expect(ls.Path).toBe("/tmp");

  expect(rpc.ls).toHaveBeenCalledTimes(1);
  expect(rpc.getBeaconTaskContent).toHaveBeenCalledWith(
    { ID: taskId },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

test("SliverClient-created beacons fetch results only through the task-content channel", async () => {
  const taskId = "budgeted-task";
  const response = Buffer.from(Ls.encode(Ls.create({ Path: "/budgeted", Exists: true })).finish());
  const taskResult = Event.create({
    EventType: SliverClient.EVENT_BEACON_TASKRESULT,
    Data: Buffer.from(BeaconTask.encode(BeaconTask.create({ ID: taskId })).finish()),
  });
  const control = {
    ls: jest.fn(async () => Ls.create({ Response: { Async: true, BeaconID: "beacon", TaskID: taskId } })),
  };
  const artifact = { getBeaconTaskContent: jest.fn() };
  const taskContent = {
    getBeaconTaskContent: jest.fn(async () => BeaconTask.create({ ID: taskId, Response: response })),
  };
  const client = new SliverClient(dummyConfig());
  Object.assign((client as any).rpcClients, {
    control,
    artifact,
    "task-content": taskContent,
  });

  const task = await client.interactBeacon("beacon").lsTask(".", 0);
  const wait = task.wait(0);
  (client as any).eventSubject.next(taskResult);
  await expect(wait).resolves.toMatchObject({ Path: "/budgeted" });
  expect(taskContent.getBeaconTaskContent).toHaveBeenCalledTimes(1);
  expect(artifact.getBeaconTaskContent).not.toHaveBeenCalled();
});

test("InteractiveBeacon accepts a synchronous task-result source with no deadline", async () => {
  const taskId = "sync-task";
  const response = Buffer.from(Ls.encode(Ls.create({ Path: "/sync", Exists: true })).finish());
  const rpc = {
    ls: jest.fn(async () => Ls.create({ Response: { Async: true, BeaconID: "beacon", TaskID: taskId } })),
    getBeaconTaskContent: jest.fn(async () => BeaconTask.create({ ID: taskId, Response: response })),
  };
  const event = {
    EventType: SliverClient.EVENT_BEACON_TASKRESULT,
    Data: Buffer.from(BeaconTask.encode(BeaconTask.create({ ID: taskId })).finish()),
    Err: "",
  };
  const beacon = new InteractiveBeacon(rpc as any, of(event), "beacon");

  const task = await beacon.lsTask(".", 0);
  await expect(task.wait(0)).resolves.toMatchObject({ Path: "/sync" });
});

test("InteractiveBeacon validates task wait deadlines before subscribing", async () => {
  const taskResult$ = new Subject<Event>();
  const rpc = {
    ls: jest.fn(async () => Ls.create({ Response: { Async: true, BeaconID: "beacon", TaskID: "task" } })),
    getBeaconTaskContent: jest.fn(),
  };
  const beacon = new InteractiveBeacon(rpc as any, taskResult$, "beacon");
  const task = await beacon.lsTask(".", 1);

  await expect(task.wait(-1)).rejects.toBeInstanceOf(RangeError);
  await expect(task.wait(0.5)).rejects.toBeInstanceOf(RangeError);
  expect(taskResult$.observed).toBe(false);
  expect(rpc.getBeaconTaskContent).not.toHaveBeenCalled();
});

test("InteractiveSession preserves the v1 constructor signature", async () => {
  const ping = jest.fn(async () => ({ Nonce: 7 }));
  const session = new InteractiveSession({ ping } as any, {} as any, "session-1");

  await session.ping(7, 5);

  expect(ping).toHaveBeenCalledWith(
    {
      Nonce: 7,
      Request: expect.objectContaining({ SessionID: "session-1", BeaconID: "" }),
    },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

test("InteractiveSession routes response-bearing execute separately from control", async () => {
  const control = { execute: jest.fn(async () => ({})) };
  const artifact = { execute: jest.fn(async () => ({})) };
  const responseArtifact = { execute: jest.fn(async () => ({})) };
  const session = new InteractiveSession(
    control as any,
    artifact as any,
    responseArtifact as any,
    {} as any,
    "session-response",
  );

  await session.execute("/usr/bin/printf", ["large"], true, 0);
  await session.execute("/usr/bin/true", [], false, 0);

  expect(responseArtifact.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      Path: "/usr/bin/printf",
      Output: true,
      Request: expect.objectContaining({ Async: false, SessionID: "session-response" }),
    }),
    { signal: expect.any(AbortSignal) },
  );
  expect(control.execute).toHaveBeenCalledWith(
    expect.objectContaining({ Path: "/usr/bin/true", Output: false }),
    { signal: expect.any(AbortSignal) },
  );
  expect(artifact.execute).not.toHaveBeenCalled();
});
