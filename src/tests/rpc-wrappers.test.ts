import { Subject } from "rxjs";

import { SliverClient, InteractiveBeacon } from "../client";
import type { SliverClientConfig } from "../config";
import {
  BeaconTask,
  type Event,
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
  (client as any).rpcClient = { getSessions };

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
  (client as any).rpcClient = { getOperators };

  const operators = await client.operators(5);
  expect(operators[0].Name).toBe("op");
  expect(getOperators).toHaveBeenCalledTimes(1);
});

test("SliverClient.startMTLSListener() forwards to rpc.startMTLSListener()", async () => {
  const startMTLSListener = jest.fn(async () => ListenerJob.create({ ID: "listener", JobID: 1 }));

  const client = new SliverClient(dummyConfig());
  (client as any).rpcClient = { startMTLSListener };

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
  (client as any).rpcClient = { killJob };

  const res = await client.killJob(7, 5);
  expect(res.Success).toBe(true);
  expect(killJob).toHaveBeenCalledWith({ ID: 7 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

test("SliverClient.lootRemove() forwards to rpc.lootRm()", async () => {
  const lootRm = jest.fn(async () => Empty.create({}));

  const client = new SliverClient(dummyConfig());
  (client as any).rpcClient = { lootRm };

  await client.lootRemove("loot-1", 5);
  expect(lootRm).toHaveBeenCalledWith({ ID: "loot-1" } as Loot, expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

test("SliverClient.websiteUpdateContent() forwards to rpc.websiteUpdateContent()", async () => {
  const websiteUpdateContent = jest.fn(async () => ({ ID: "w", Name: "w", Contents: {} }));

  const client = new SliverClient(dummyConfig());
  (client as any).rpcClient = { websiteUpdateContent };

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

test("SliverClient.generateSpoofMetadata() forwards to rpc.generateSpoofMetadata()", async () => {
  const generateSpoofMetadata = jest.fn(async () => Empty.create({}));

  const client = new SliverClient(dummyConfig());
  (client as any).rpcClient = { generateSpoofMetadata };

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
