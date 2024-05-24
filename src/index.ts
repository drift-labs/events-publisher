import Client, {
	CommitmentLevel,
	SubscribeRequest,
	SubscribeUpdate,
} from '@triton-one/yellowstone-grpc';
import {
	DriftClient,
	DriftEnv,
	EventType,
	Wallet,
	parseLogs,
} from '@drift-labs/sdk';
import { RedisClient } from '@drift/common';
import { ClientDuplexStream } from '@grpc/grpc-js';
import { Connection, Keypair } from '@solana/web3.js';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import { getSerializerFromEventType } from './utils/utils';

require('dotenv').config();

type grpcEventsSubscriberConfig = {
	programId: string;
	endpoint: string;
	token: string;
};

const driftEnv = (process.env.ENV || 'devnet') as DriftEnv;
const endpoint = process.env.GRPC_ENDPOINT;
if (!endpoint) {
	throw new Error('Missing GRPC_ENDPOINT');
}
const token = process.env.TOKEN;
const WRITING = process.env.WRITING === 'true';

export class GrpcEventSubscriber {
	config: grpcEventsSubscriberConfig;
	driftClient: DriftClient;
	redisClient: RedisClient;
	stream?: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;
	mostRecentSlot: number = -1;

	constructor(
		driftClient: DriftClient,
		redisClient: RedisClient,
		config: grpcEventsSubscriberConfig
	) {
		this.driftClient = driftClient;
		this.redisClient = redisClient;
		this.config = config;
	}

	public async subscribe(): Promise<void> {
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

		this.stream.on('data', (chunk: any) => {
			if (!chunk.transaction) {
				return;
			}
			const slot = Number(chunk.transaction.slot);
			if (slot > this.mostRecentSlot) this.mostRecentSlot = slot;
			const logs = chunk.transaction.transaction.meta.logMessages;
			const events = parseLogs(this.driftClient.program, logs);
			const txSig = bs58.encode(chunk.transaction.transaction.signature);

			let runningEventIndex = 0;
			for (const event of events) {
				// @ts-ignore
				event.data.txSig = txSig;
				event.data.slot = slot;
				event.data.eventType = event.name;
				event.data.txSigIndex = runningEventIndex;

				const eventType = event.name as EventType;
				const serializer = getSerializerFromEventType(eventType);
				if (serializer) {
					const serialized = serializer(event.data);
					if (WRITING) {
						this.redisClient.rPush(event.name, JSON.stringify(serialized));
					}
					this.redisClient.publish(event.name, serialized);
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
				}
			);
		}).catch((reason) => {
			console.error(reason);
			throw reason;
		});
	}
}

async function main() {
	const redisClient = new RedisClient({});
	await redisClient.connect();

	const driftClient = new DriftClient({
		env: driftEnv,
		connection: new Connection(endpoint!),
		wallet: new Wallet(new Keypair()),
	});

	const eventSubscriber = new GrpcEventSubscriber(driftClient, redisClient, {
		programId: driftClient.program.programId.toString(),
		endpoint: endpoint!,
		token: token!,
	});

	await eventSubscriber.subscribe();
}

main();
