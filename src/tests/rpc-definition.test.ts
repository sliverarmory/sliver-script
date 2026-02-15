import { SliverRPCDefinition } from "../pb/rpcpb/services";

test("RPC definition includes all methods (snapshot)", () => {
  const methods = Object.entries(SliverRPCDefinition.methods)
    .map(([key, def]) => ({
      key,
      name: def.name,
      requestStream: def.requestStream,
      responseStream: def.responseStream,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  expect({
    name: SliverRPCDefinition.name,
    fullName: SliverRPCDefinition.fullName,
    methods,
  }).toMatchSnapshot();
});

