import Client, {
  CommitmentLevel,
  SubscribeRequest,
  SubscribeUpdate,
} from "@triton-one/yellowstone-grpc";
import {
  DriftClient,
  DriftEnv,
  EventType,
  SwiftOrderRecord,
  Wallet,
} from "@drift-labs/sdk";
import { ClientDuplexStream } from "@grpc/grpc-js";
import { Connection, Keypair } from "@solana/web3.js";
import { fromEventPattern } from "rxjs";
import { parseLogsWithRaw } from "@drift-labs/sdk";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm"; // ES Modules import
import Redis from "ioredis";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { getSerializerFromEventType } from "./utils/utils";
import { RedisClient } from "@drift/common/clients";

require("dotenv").config();

type grpcEventsSubscriberConfig = {
  programId: string;
  endpoint: string;
  token: string;
};

const driftEnv = (process.env.ENV || "devnet") as DriftEnv;
const endpoint = process.env.GRPC_ENDPOINT;
if (!endpoint) {
  throw new Error("Missing GRPC_ENDPOINT");
}
const token = process.env.TOKEN;

export class GrpcEventSubscriber {
  config: grpcEventsSubscriberConfig;
  driftClient: DriftClient;
  stream?: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;
  mostRecentSlot: number = -1;

  constructor(driftClient: DriftClient, config: grpcEventsSubscriberConfig) {
    this.driftClient = driftClient;
    this.config = config;
  }

  public async subscribe(): Promise<void> {
    const redis = new RedisClient({});
    await redis.connect();

    const client = new Client(this.config.endpoint, this.config.token);
    this.stream = await client.subscribe();
    const request: SubscribeRequest = {
      slots: {},
      accounts: {},
      transactions: {
        drift: {
          vote: false,
          failed: false,
          accountInclude: [this.config.programId],
          accountExclude: [],
          accountRequired: [],
        },
      },
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.CONFIRMED,
      entry: {},
    };

    this.stream.on("data", (chunk: any) => {
      if (!chunk.transaction) {
        return;
      }
      const slot = Number(chunk.transaction.slot);
      if (slot > this.mostRecentSlot) this.mostRecentSlot = slot;
      const logs = chunk.transaction.transaction.meta.logMessages;
      const { events, rawLogs } = parseLogsWithRaw(
        this.driftClient.program,
        logs,
      );
      const txSig = bs58.encode(chunk.transaction.transaction.signature);

      let runningEventIndex = 0;
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const rawLog = rawLogs[i];

        // @ts-ignore
        event.data.txSig = txSig;
        event.data.slot = slot;
        event.data.eventType = event.name;
        event.data.txSigIndex = runningEventIndex;

        const eventType = event.name as EventType;
        if (eventType === "SwiftOrderRecord") {
          const hash = event.data.hash;
          redis.setExpiring(`swift-hashes::${hash}`, "whats good", 60 * 3);
          continue;
        }

        const serializer = getSerializerFromEventType(eventType);
        if (serializer) {
          const serialized = serializer(event.data);
          serialized.rawLog = rawLog;
          redis.publish(event.name, JSON.stringify(serialized));
        }
        runningEventIndex++;
      }
    });

    return new Promise<void>((resolve, reject) => {
      this.stream!.write(request, (err: Error) => {
        if (err === null || err === undefined) {
          resolve();
        } else {
          reject(err);
        }
      });
    }).catch((reason) => {
      console.error(reason);
      throw reason;
    });
  }

  public async unsubscribe(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.stream!.write(
        {
          slots: {},
          accounts: {},
          transactions: {},
          blocks: {},
          blocksMeta: {},
          accountsDataSlice: [],
          entry: {},
        },
        (err: Error) => {
          if (err === null || err === undefined) {
            resolve();
          } else {
            reject(err);
          }
        },
      );
    }).catch((reason) => {
      console.error(reason);
      throw reason;
    });
  }
}

async function main() {
  const driftClient = new DriftClient({
    env: driftEnv,
    connection: new Connection(endpoint!),
    wallet: new Wallet(new Keypair()),
  });
  const eventSubscriber = new GrpcEventSubscriber(driftClient, {
    programId: driftClient.program.programId.toString(),
    endpoint: endpoint!,
    token: token!,
  });
  await eventSubscriber.subscribe();
}

main();
