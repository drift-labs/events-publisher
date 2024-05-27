import { RedisClient } from '@drift/common';
import { v4 as uuidv4 } from 'uuid';

const REDIS_CONFIG_KEY = 'events-publisher-config';
const CLIENT = uuidv4();
const REDIS_CHANNEL_PREFIX = `events-client`;
const REDIS_CLIENT_CHANNEL = `${REDIS_CHANNEL_PREFIX}-${CLIENT}`;

interface Client {
	id: string;
	isWriting?: boolean;
	isFailover?: boolean;
}

export const ConfigurationService = (redisClient: RedisClient) => {
	console.log(`Starting up client: ${CLIENT}`);

	const setupClient = async () => {
		await redisClient.rPush(REDIS_CONFIG_KEY, JSON.stringify({ id: CLIENT }));
		await checkIfShouldPromote();
		console.log('returning');
	};

	const shutdown = async () => {
		const clients = await getClients();
		const client = clients?.find((client) => client.id === CLIENT);

		console.log(`Shutting down client: ${CLIENT}`);

		if (client && clients.length > 1) {
			await redisClient.lRem(REDIS_CONFIG_KEY, 1, JSON.stringify(client));
			if (client.isWriting) {
				await promote();
			}
		} else if (client && clients.length === 1) {
			console.log(`No clients are currently running`);
			// TODO this should throw an alert as it should never happen
			await redisClient.delete(REDIS_CONFIG_KEY);
		}
	};

	const awaitPromotion = async ({ callback }) => {
		await redisClient.subscribe(REDIS_CLIENT_CHANNEL);

		redisClient.forceGetClient().on('message', async (channel, message) => {
			if (channel === REDIS_CLIENT_CHANNEL) {
				const { isWriting = false, isFailover = false } = JSON.parse(message);
				if (isWriting) {
					console.log(`Starting to write on client: ${CLIENT}`);
					callback();
				}
				if (isFailover) throw new Error(`Failing over client: ${CLIENT}`);
			}
		});
	};

	const checkIfShouldPromote = async () => {
		console.log('in function')
		return setTimeout(async () => {
			console.log('in timeout')
			const clients = await getClients();
			const clientIsWriting = clients?.find((client) => client.isWriting);
			if (!clientIsWriting) {
				await promote();
			}
		}, 3000);
	};

	const promote = async () => {
		const clients = await getClients();
		const firstClient = clients?.[0];

		if (!firstClient) {
			console.log('Failed promoting a client: Unable to find client');
			return;
		}

		const payload = { ...firstClient, isWriting: true };

		console.log(`Promoting client: ${firstClient.id}`);

		await redisClient
			.forceGetClient()
			.lset(REDIS_CONFIG_KEY, 0, JSON.stringify(payload));

		await redisClient.publish(
			`${REDIS_CHANNEL_PREFIX}-${firstClient.id}`,
			payload
		);
	};

	const getClients = async (): Promise<Client[]> => {
		return (await redisClient.lRange(REDIS_CONFIG_KEY, 0, -1))?.map((client) =>
			JSON.parse(client)
		);
	};

	return {
		setupClient,
		shutdown,
		awaitPromotion,
		checkIfShouldPromote,
	};
};
