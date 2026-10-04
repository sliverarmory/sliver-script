import * as grpc from "@grpc/grpc-js";

import { RPC_MESSAGE_BUDGETS, rpcMessageChannelOptions } from "../messageBudget";

const METHOD_PATH = "/sliver.script.test.MessageBudget/Probe";

let client: grpc.Client | undefined;
let server: grpc.Server | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  if (server) {
    const activeServer = server;
    server = undefined;
    await new Promise<void>((resolve) => activeServer.tryShutdown(() => resolve()));
  }
});

describe("grpc-js allocation enforcement", () => {
  test("rejects oversized control messages before either receiver deserializes them", async () => {
    let serverDecodedRequest = false;
    let clientDecodedResponse = false;
    const definition: grpc.MethodDefinition<Buffer, Buffer> = {
      path: METHOD_PATH,
      originalName: "probe",
      requestStream: false,
      responseStream: false,
      requestSerialize: identity,
      requestDeserialize: (value) => {
        serverDecodedRequest = true;
        return value;
      },
      responseSerialize: identity,
      responseDeserialize: identity,
    };

    server = new grpc.Server();
    server.addService(
      { probe: definition },
      {
        probe(
          _call: grpc.ServerUnaryCall<Buffer, Buffer>,
          callback: grpc.sendUnaryData<Buffer>,
        ): void {
          callback(null, Buffer.alloc(RPC_MESSAGE_BUDGETS.control.maxReceiveBytes + 1));
        },
      },
    );
    const port = await bind(server);
    client = new grpc.Client(
      `127.0.0.1:${port}`,
      grpc.credentials.createInsecure(),
      rpcMessageChannelOptions("control"),
    );

    const inbound = await unary(client, Buffer.alloc(0), () => {
      clientDecodedResponse = true;
    });
    expect(inbound.error?.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
    expect(serverDecodedRequest).toBe(true);
    expect(clientDecodedResponse).toBe(false);

    serverDecodedRequest = false;
    clientDecodedResponse = false;
    const outbound = await unary(
      client,
      Buffer.alloc(RPC_MESSAGE_BUDGETS.control.maxSendBytes + 1),
      () => {
        clientDecodedResponse = true;
      },
    );
    expect(outbound.error?.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
    expect(serverDecodedRequest).toBe(false);
    expect(clientDecodedResponse).toBe(false);
  });

  test.each(["task-content", "tunnel-stream"] as const)(
    "enforces the %s receive limit before decoding unary responses",
    async (domain) => {
      const limit = RPC_MESSAGE_BUDGETS[domain].maxReceiveBytes;
      let response = Buffer.alloc(limit, 0x61);
      const beforeDecode = jest.fn();
      server = new grpc.Server();
      server.addService(
        { probe: unaryDefinition() },
        {
          probe(
            _call: grpc.ServerUnaryCall<Buffer, Buffer>,
            callback: grpc.sendUnaryData<Buffer>,
          ): void {
            callback(null, response);
          },
        },
      );
      const port = await bind(server);
      client = new grpc.Client(
        `127.0.0.1:${port}`,
        grpc.credentials.createInsecure(),
        rpcMessageChannelOptions(domain),
      );

      const accepted = await unary(client, Buffer.alloc(0), beforeDecode);
      expect(accepted.error).toBeNull();
      expect(accepted.response).toEqual(response);
      expect(beforeDecode).toHaveBeenCalledTimes(1);

      response = Buffer.alloc(limit + 1, 0x61);
      beforeDecode.mockClear();
      const rejected = await unary(client, Buffer.alloc(0), beforeDecode);
      expect(rejected.error?.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
      expect(rejected.response).toBeUndefined();
      expect(beforeDecode).not.toHaveBeenCalled();
    },
  );
});

function identity(value: Buffer): Buffer {
  return value;
}

function unaryDefinition(): grpc.MethodDefinition<Buffer, Buffer> {
  return {
    path: METHOD_PATH,
    originalName: "probe",
    requestStream: false,
    responseStream: false,
    requestSerialize: identity,
    requestDeserialize: identity,
    responseSerialize: identity,
    responseDeserialize: identity,
  };
}

async function bind(activeServer: grpc.Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    activeServer.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, port) => error ? reject(error) : resolve(port),
    );
  });
}

async function unary(
  activeClient: grpc.Client,
  request: Buffer,
  beforeDecode: () => void,
): Promise<{ error: grpc.ServiceError | null; response?: Buffer }> {
  return new Promise((resolve) => {
    activeClient.makeUnaryRequest(
      METHOD_PATH,
      identity,
      (value) => {
        beforeDecode();
        return value;
      },
      request,
      (error, response) => resolve({ error, ...(response ? { response } : {}) }),
    );
  });
}
