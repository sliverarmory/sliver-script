import { SliverClient } from "../client";
import type { SliverClientConfig } from "../config";
import { BeaconTask } from "../pb/clientpb/client";
import { Envelope, RegisterExtension, RegisterExtensionReq } from "../pb/sliverpb/sliver";

function client(): SliverClient {
  const config: SliverClientConfig = {
    operator: "test",
    token: "test",
    lhost: "localhost",
    lport: 31337,
    ca_certificate: "",
    certificate: "",
    private_key: "",
  };
  return new SliverClient(config);
}

test("large native extension registration uses the artifact channel and clears its copy", async () => {
  const sliver = client();
  const data = Buffer.alloc(12 * 1024 * 1024, 0x5a);
  let sentData: Buffer | undefined;
  const registerExtension = jest.fn(async (request: RegisterExtensionReq) => {
    sentData = request.Data;
    expect(request.Data).not.toBe(data);
    expect(request.Data.length).toBe(data.length);
    expect(request.Data[0]).toBe(0x5a);
    expect(request.Name).toBe("rusthound-ce-a1");
    expect(request.Request).toMatchObject({ SessionID: "session-1", Async: false });
    return RegisterExtension.create({ Response: { Err: "" } });
  });
  (sliver as any).rpcClients["workbench-artifact"] = { registerExtension };
  (sliver as any).rpcClients.control = { registerExtension: jest.fn(() => { throw new Error("wrong channel"); }) };

  await sliver.registerNativeExtensionSession("session-1", {
    name: "rusthound-ce-a1", data, os: "windows",
  }, 60);

  expect(registerExtension).toHaveBeenCalledTimes(1);
  expect(sentData?.every((byte) => byte === 0)).toBe(true);
  expect(data[0]).toBe(0x5a);
});

test("beacon registration uses the artifact channel and returns the task receipt", async () => {
  const sliver = client();
  const registerExtension = jest.fn(async (request: RegisterExtensionReq) => {
    expect(request.Request).toMatchObject({ BeaconID: "beacon-1", Async: true });
    return RegisterExtension.create({ Response: { Async: true, BeaconID: "beacon-1", TaskID: "task-1" } });
  });
  (sliver as any).rpcClients["workbench-artifact"] = { registerExtension };

  const receipt = await sliver.registerNativeExtensionBeacon("beacon-1", {
    name: "rusthound-ce-a1", data: Buffer.from([1, 2, 3]), os: "windows",
  });

  expect(receipt.Response?.TaskID).toBe("task-1");
  expect(registerExtension).toHaveBeenCalledTimes(1);
});

test("large beacon registration task is fetched through the artifact channel with exact identity", async () => {
  const sliver = client();
  const request = RegisterExtensionReq.create({
    Name: "rusthound-ce-a1", Data: Buffer.alloc(12 * 1024 * 1024), OS: "windows",
  });
  const envelope = Envelope.create({ Data: Buffer.from(RegisterExtensionReq.encode(request).finish()) });
  const task = BeaconTask.create({
    ID: "task-1", BeaconID: "beacon-1", Description: "RegisterExtensionReq", State: "completed",
    Request: Buffer.from(Envelope.encode(envelope).finish()),
    Response: Buffer.from(RegisterExtension.encode(RegisterExtension.create({ Response: { Err: "" } })).finish()),
  });
  const getBeaconTaskContent = jest.fn(async () => task);
  (sliver as any).rpcClients["workbench-artifact"] = { getBeaconTaskContent };
  (sliver as any).rpcClients["task-content"] = { getBeaconTaskContent: jest.fn(() => { throw new Error("wrong channel"); }) };

  const result = await sliver.fetchNativeExtensionRegistrationTask("beacon-1", "task-1", "rusthound-ce-a1");

  expect(result).toBe(task);
  expect(getBeaconTaskContent).toHaveBeenCalledWith({ ID: "task-1" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  await expect(sliver.fetchNativeExtensionRegistrationTask("other-beacon", "task-1", "rusthound-ce-a1"))
    .rejects.toThrow("identity mismatch");
  await expect(sliver.fetchNativeExtensionRegistrationTask("beacon-1", "task-1", "other-extension"))
    .rejects.toThrow("name mismatch");
});

test("native extension registration rejects oversized DLLs before RPC", async () => {
  const sliver = client();
  const registerExtension = jest.fn();
  (sliver as any).rpcClients["workbench-artifact"] = { registerExtension };

  expect(() => sliver.registerNativeExtensionSession("session-1", {
    name: "rusthound-ce-a1", data: Buffer.alloc(32 * 1024 * 1024 + 1), os: "windows",
  })).toThrow("Native extension must contain");
  expect(registerExtension).not.toHaveBeenCalled();
});
