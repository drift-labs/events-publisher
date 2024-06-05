import Client, {
	CommitmentLevel,
	SubscribeRequest,
	SubscribeUpdate,
} from '@triton-one/yellowstone-grpc';
import { ClientDuplexStream } from '@grpc/grpc-js';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import { DriftClient, EventType, parseLogs } from '@drift-labs/sdk';
import { Logger, RedisClient } from '@drift/common';

import { getSerializerFromEventType, getTtlForRecord } from '../utils/utils';

type GrpcEventsSubscriberConfig = {
	programId: string;
	endpoint: string;
	token: string;
};

const WRITING = process.env.WRITING === 'true';

export const GrpcEventSubscriber = (
	driftClient: DriftClient,
	redisClient: RedisClient,
	logger: Logger,
	config: GrpcEventsSubscriberConfig
) => {
	let stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;
	let mostRecentSlot = -1;
	let currentlyWriting = true;

	const subscribe = async (): Promise<void> => {
		const client = new Client(config.endpoint, config.token);
		stream = await client.subscribe();
		const request: SubscribeRequest = {
			slots: {},
			accounts: {},
			transactions: {
				drift: {
					vote: false,
					failed: false,
					accountInclude: [config.programId],
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

		stream.on('data', async (chunk: any) => {
			const startTime = Date.now();

			if (!chunk.transaction) {
				return;
			}

			const slot = Number(chunk.transaction.slot);
			console.log('Writing', slot)
			if (slot > mostRecentSlot) mostRecentSlot = slot;
			const logs = chunk.transaction.transaction.meta.logMessages;
			const events = parseLogs(driftClient.program, logs);
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
						await redisClient.zAdd(
							event.name,
							startTime + getTtlForRecord(eventType, serialized),
							JSON.stringify(serialized)
						);
					}
					await redisClient.publish(event.name, serialized);
				}
				runningEventIndex++;
			}

			// Only remove OrderActionRecords for now
			await redisClient.zRemRangeByScore(
				'OrderActionRecord',
				-Infinity,
				startTime
			);

			currentlyWriting = true;
		});

		setInterval(() => {
			if (!currentlyWriting) {
				throw new Error('Publisher has not written an event in 10000ms');
			}
			currentlyWriting = false;
		}, 10000);

		return new Promise<void>((resolve, reject) => {
			stream!.write(request, (err: Error) => {
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
	};

	const unsubscribe = async (): Promise<void> => {
		return new Promise<void>((resolve, reject) => {
			stream!.write(
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
	};

	return {
		subscribe,
		unsubscribe,
	};
};
