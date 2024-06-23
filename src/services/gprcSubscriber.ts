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
	let inactivityTimer;

	const resetInactivityTimer = () => {
		if (inactivityTimer) {
			clearTimeout(inactivityTimer);
		}
		inactivityTimer = setTimeout(() => {
			throw new Error('Publisher has not written an event in 30000ms');
		}, 30000);
	};

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
			resetInactivityTimer();
			
			const startTime = Date.now();

			if (!chunk.transaction) {
				return;
			}

			const slot = Number(chunk.transaction.slot);
			console.log('Writing', slot);
			if (slot > mostRecentSlot) mostRecentSlot = slot;
			const logs = chunk.transaction.transaction.meta.logMessages;
			const events = parseLogs(driftClient.program, logs);
			const txSig = bs58.encode(chunk.transaction.transaction.signature);

			const eventTypes = new Set<string>();

			const promises = [];

			let runningEventIndex = 0;
			for (const event of events) {
				// @ts-ignore
				event.data.txSig = txSig;
				event.data.slot = slot;
				event.data.eventType = event.name;
				event.data.txSigIndex = runningEventIndex;

				const eventType = event.name as EventType;
				eventTypes.add(eventType);

				const serializer = getSerializerFromEventType(eventType);
				if (serializer) {
					const serialized = serializer(event.data);
					if (WRITING) {
						promises.push(
							redisClient.zAdd(
								event.name,
								startTime + getTtlForRecord(eventType, serialized),
								JSON.stringify(serialized)
							)
						);
					}
					promises.push(redisClient.publish(event.name, serialized));
				}
				runningEventIndex++;
			}

			await Promise.all(promises);

			await Promise.all(
				Array.from(eventTypes).map(async (eventType) => {
					await redisClient.zRemRangeByScore(eventType, -Infinity, startTime);
				})
			);
		});

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

	const currentSlot = () => {
		return mostRecentSlot;
	};

	return {
		subscribe,
		unsubscribe,
		currentSlot,
	};
};
