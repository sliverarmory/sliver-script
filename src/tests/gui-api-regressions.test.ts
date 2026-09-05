import { SliverClient } from "../client";
import type { SliverClientConfig } from "../config";
import {
  Compiler,
  Event,
  Generate,
  ImplantConfig,
  ListenerJob,
  OutputFormat,
  StageProtocol,
  StagerListener,
  StagerListenerReq,
} from "../pb/clientpb/client";
import { File as SliverFile } from "../pb/commonpb/common";

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

function clientWithRpc(rpc: Record<string, unknown>): SliverClient {
  const client = new SliverClient(dummyConfig());
  Object.assign((client as any).rpcClients, {
    control: rpc,
    inventory: rpc,
    artifact: rpc,
    "workbench-artifact": rpc,
    "task-content": rpc,
    "tunnel-stream": rpc,
  });
  return client;
}

const rpcOptions = expect.objectContaining({ signal: expect.any(AbortSignal) });

describe("GUI generation APIs", () => {
  test("generateImplant forwards Name and preserves the full Generate response", async () => {
    const config = ImplantConfig.create({ GOOS: "linux", GOARCH: "amd64" });
    const response = Generate.create({
      File: SliverFile.create({ Name: "operator-name", Data: Buffer.from([1, 2, 3]) }),
      ImplantName: "operator-name",
      ImplantBuildID: "build-123",
    });
    const generate = jest.fn(async () => response);
    const client = clientWithRpc({ generate });

    const result = await client.generateImplant(config, "operator-name", 5);

    expect(result).toBe(response);
    expect(result.File?.Name).toBe("operator-name");
    expect(result.ImplantName).toBe("operator-name");
    expect(result.ImplantBuildID).toBe("build-123");
    expect(generate).toHaveBeenCalledWith(
      { Config: config, Name: "operator-name" },
      rpcOptions,
    );
  });

  test("getCompiler returns the server compiler capabilities", async () => {
    const response = Compiler.create({
      GOOS: "darwin",
      GOARCH: "arm64",
      Targets: [{ GOOS: "linux", GOARCH: "amd64", Format: OutputFormat.EXECUTABLE }],
    });
    const getCompiler = jest.fn(async () => response);
    const client = clientWithRpc({ getCompiler });

    await expect(client.getCompiler(5)).resolves.toBe(response);
    expect(getCompiler).toHaveBeenCalledWith({}, rpcOptions);
  });
});

describe("GUI listener APIs", () => {
  test("HTTP advanced listener supplies secure defaults", async () => {
    const response = ListenerJob.create({ JobID: 10 });
    const startHTTPListener = jest.fn(async () => response);
    const client = clientWithRpc({ startHTTPListener });

    await expect(client.startHTTPListenerWithOptions({ host: "127.0.0.1", port: 8080 }, 5)).resolves.toBe(response);

    expect(startHTTPListener).toHaveBeenCalledWith(
      {
        Domain: "",
        Host: "127.0.0.1",
        Port: 8080,
        Secure: false,
        Website: "",
        Cert: Buffer.alloc(0),
        Key: Buffer.alloc(0),
        ACME: false,
        EnforceOTP: true,
        LongPollTimeout: "1000000000",
        LongPollJitter: "2000000000",
        RandomizeJARM: false,
      },
      rpcOptions,
    );
  });

  test("HTTP advanced listener forwards explicit options", async () => {
    const startHTTPListener = jest.fn(async () => ListenerJob.create({ JobID: 11 }));
    const client = clientWithRpc({ startHTTPListener });

    await client.startHTTPListenerWithOptions({
      domain: "example.test",
      host: "0.0.0.0",
      port: 8081,
      website: "decoy",
      enforceOTP: false,
      longPollTimeoutNanoseconds: "3000000000",
      longPollJitterNanoseconds: "4000000000",
    }, 5);

    expect(startHTTPListener).toHaveBeenCalledWith(
      expect.objectContaining({
        Domain: "example.test",
        Host: "0.0.0.0",
        Port: 8081,
        Secure: false,
        Website: "decoy",
        EnforceOTP: false,
        LongPollTimeout: "3000000000",
        LongPollJitter: "4000000000",
        RandomizeJARM: false,
      }),
      rpcOptions,
    );
  });

  test("HTTPS advanced listener supplies secure defaults", async () => {
    const response = ListenerJob.create({ JobID: 12 });
    const startHTTPSListener = jest.fn(async () => response);
    const client = clientWithRpc({ startHTTPSListener });

    await expect(client.startHTTPSListenerWithOptions({ host: "127.0.0.1", port: 8443 }, 5)).resolves.toBe(response);

    expect(startHTTPSListener).toHaveBeenCalledWith(
      {
        Domain: "",
        Host: "127.0.0.1",
        Port: 8443,
        Secure: true,
        Website: "",
        Cert: Buffer.alloc(0),
        Key: Buffer.alloc(0),
        ACME: false,
        EnforceOTP: true,
        LongPollTimeout: "1000000000",
        LongPollJitter: "2000000000",
        RandomizeJARM: true,
      },
      rpcOptions,
    );
  });

  test("HTTPS advanced listener forwards certificates and explicit options", async () => {
    const cert = Buffer.from("cert");
    const key = Buffer.from("key");
    const startHTTPSListener = jest.fn(async () => ListenerJob.create({ JobID: 13 }));
    const client = clientWithRpc({ startHTTPSListener });

    await client.startHTTPSListenerWithOptions({
      domain: "secure.example.test",
      host: "0.0.0.0",
      port: 443,
      website: "secure-decoy",
      acme: true,
      cert,
      key,
      enforceOTP: false,
      longPollTimeoutNanoseconds: "5000000000",
      longPollJitterNanoseconds: "6000000000",
      randomizeJARM: false,
    }, 5);

    expect(startHTTPSListener).toHaveBeenCalledWith(
      {
        Domain: "secure.example.test",
        Host: "0.0.0.0",
        Port: 443,
        Secure: true,
        Website: "secure-decoy",
        Cert: cert,
        Key: key,
        ACME: true,
        EnforceOTP: false,
        LongPollTimeout: "5000000000",
        LongPollJitter: "6000000000",
        RandomizeJARM: false,
      },
      rpcOptions,
    );
  });

  test("TCP stager advanced listener preserves ProfileName", async () => {
    const response = StagerListener.create({ JobID: 14 });
    const startTCPStagerListener = jest.fn(async () => response);
    const client = clientWithRpc({ startTCPStagerListener });
    const request = StagerListenerReq.create({
      Protocol: StageProtocol.HTTPS,
      Host: "0.0.0.0",
      Port: 9443,
      Data: Buffer.from([4, 5, 6]),
      ProfileName: "production-stage",
    });

    await expect(client.startTCPStagerListenerWithOptions(request, 5)).resolves.toBe(response);
    expect(startTCPStagerListener).toHaveBeenCalledWith(request, rpcOptions);
  });
});

describe("GUI event stream reliability", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("a transient stream failure retries without permanently erroring event$", async () => {
    jest.useFakeTimers();

    const recoveredEvent = Event.create({ EventType: "job-started", Err: "" });
    const events = jest
      .fn()
      .mockImplementationOnce(() => ({
        [Symbol.asyncIterator]: async function* () {
          throw new Error("temporary event stream failure");
        },
      }))
      .mockImplementationOnce((_request: unknown, options: { signal: AbortSignal }) => ({
        [Symbol.asyncIterator]: async function* () {
          yield recoveredEvent;
          await new Promise<void>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      }));

    const client = clientWithRpc({ events });
    (client as any).eventsAbort = new AbortController();

    const received: Event[] = [];
    const streamErrors: unknown[] = [];
    const states: Array<{ status: string; attempt: number; error?: string }> = [];
    const eventSubscription = client.event$.subscribe({
      next: (event) => received.push(event),
      error: (error) => streamErrors.push(error),
    });
    const stateSubscription = client.eventStreamState$.subscribe((state) => states.push(state));

    (client as any).startEventsStream();
    await Promise.resolve();
    await Promise.resolve();

    expect(states).toContainEqual({
      status: "retrying",
      attempt: 1,
      error: "temporary event stream failure",
    });

    await jest.advanceTimersByTimeAsync(500);

    expect(events).toHaveBeenCalledTimes(2);
    expect(received).toEqual([recoveredEvent]);
    expect(streamErrors).toEqual([]);
    expect(states).toContainEqual({ status: "connected", attempt: 1 });

    await client.disconnect();
    eventSubscription.unsubscribe();
    stateSubscription.unsubscribe();
  });

  test("preserves exponential backoff until a stream yields its first event", async () => {
    jest.useFakeTimers();

    const recoveredEvent = Event.create({ EventType: "session-opened", Err: "" });
    const failingStream = (message: string) => ({
      [Symbol.asyncIterator]: async function* () {
        throw new Error(message);
      },
    });
    const events = jest
      .fn()
      .mockImplementationOnce(() => failingStream("first establishment failure"))
      .mockImplementationOnce(() => failingStream("second establishment failure"))
      .mockImplementationOnce((_request: unknown, options: { signal: AbortSignal }) => ({
        [Symbol.asyncIterator]: async function* () {
          yield recoveredEvent;
          await new Promise<void>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      }));
    const client = clientWithRpc({ events });
    (client as any).eventsAbort = new AbortController();
    const states: Array<{ status: string; attempt: number; error?: string }> = [];
    const subscription = client.eventStreamState$.subscribe((state) => states.push(state));

    (client as any).startEventsStream();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toHaveBeenCalledTimes(1);
    expect(states.filter((state) => state.status === "connected")).toEqual([]);

    await jest.advanceTimersByTimeAsync(500);
    expect(events).toHaveBeenCalledTimes(2);
    expect(states).toContainEqual({
      status: "retrying", attempt: 2, error: "second establishment failure",
    });

    await jest.advanceTimersByTimeAsync(999);
    expect(events).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(events).toHaveBeenCalledTimes(3);
    expect(states).toContainEqual({ status: "connected", attempt: 2 });

    await client.disconnect();
    subscription.unsubscribe();
  });
});
