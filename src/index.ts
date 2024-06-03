require('dotenv').config();

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
import { ClientDuplexStream } from '@grpc/grpc-js';
import { Connection, Keypair } from '@solana/web3.js';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import { getSerializerFromEventType } from './utils/utils';
import { ConfigurationService } from './utils/configuration';

import { RedisClient, logger } from '@drift/common';

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
	currentlyWriting: boolean;

	constructor(
		driftClient: DriftClient,
		redisClient: RedisClient,
		config: grpcEventsSubscriberConfig
	) {
		this.driftClient = driftClient;
		this.redisClient = redisClient;
		this.config = config;
		this.currentlyWriting = true;
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

			this.currentlyWriting = true;
		});

		setInterval(() => {
			if (!this.currentlyWriting) {
				throw new Error('Publisher has not written an event in 5000ms');
			}
			this.currentlyWriting = false;
		}, 5000);

		return new Promise<void>((resolve, reject) => {
			this.stream!.write(request, (err: Error) => {
				if (err === null || err === undefined) {
					resolve();
				} else {
					reject(err);
				}
			});
		}).catch((reason) => {
			logger.alert(reason);
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
			logger.error(reason);
			throw reason;
		});
	}
}

export async function main() {
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

	const { setupClient, shutdown, awaitPromotion } = ConfigurationService(
		redisClient,
		logger
	);

	const handleShutdown = async (message: string) => {
		console.log(message)
		logger.alert(message);
		await shutdown();
		process.exit();
	};

	try {
		await awaitPromotion({
			callback: async () => await eventSubscriber.subscribe(),
		});
		await setupClient();
	} catch (error) {
		console.log(error)
		await handleShutdown(`Error in events publisher: ${error.message}`);
	}

	process.on('SIGINT', () => {
		return handleShutdown(`Events Publisher interrupted`);
	});

	process.on('uncaughtException', (error: Error) => {
		return handleShutdown(
			`Shutting down container because uncaught error: ${error.message}`
		);
	});

	process.on('unhandledRejection', (error: Error) => {
		return handleShutdown(
			`Shutting down container because unhandled rejection: ${error.message}`
		);
	});
}

if (require.main === module) {
	main();
}
