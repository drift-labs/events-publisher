import { RedisClient, Logger } from '@drift/common';
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

export const ConfigurationService = (redisClient: RedisClient, logger: Logger) => {
	logger.info(`Starting up client: ${CLIENT}`);

	const setupClient = async () => {
		await redisClient.rPush(REDIS_CONFIG_KEY, JSON.stringify({ id: CLIENT }));
		await checkIfClientsConnected();
	};

	const shutdown = async () => {
		logger.info(`Shutting down client: ${CLIENT}`);
		try {
			const clients = await getClients();
			const client = clients?.find((client) => client.id === CLIENT);

			if (client && clients.length > 1) {
				await redisClient.lRem(REDIS_CONFIG_KEY, 1, JSON.stringify(client));
				if (client.isWriting) {
					await promote();
				}
			} else if (client && clients.length === 1) {
				await redisClient.delete(REDIS_CONFIG_KEY);
				throw new Error(`No event publishing clients are running`);
			}
		} catch (error) {
			logger.alert(`Failed to shutdown gracefully: ${error.message}`);
		}
	};

	const awaitPromotion = async ({ callback }) => {
		await redisClient.subscribe(REDIS_CLIENT_CHANNEL);

		redisClient.forceGetClient().on('message', async (channel, message) => {
			if (channel === REDIS_CLIENT_CHANNEL) {
				const { isWriting = false, isFailover = false } = JSON.parse(message);
				if (isWriting) {
					logger.info(`Starting to write on client: ${CLIENT}`);
					callback();
				}
				if (isFailover) throw new Error(`Failing over client: ${CLIENT}`);
			}
		});

		redisClient.forceGetClient().on('error', (e) => {
			throw new Error(`Redis Error: ${e.message}`);
		});

		redisClient.forceGetClient().on('end', () => {
			throw new Error('Redis connection was closed');
		});
	};

	const checkIfShouldPromote = async () => {
		const clients = await getClients();
		const clientIsWriting = clients?.find((client) => client.isWriting);
		if (!clientIsWriting) {
			await promote();
		}
	};

	const checkIfClientsConnected = async () => {
		const connectedClients = [CLIENT];

		await redisClient.subscribe(REDIS_CHANNEL_PREFIX);

		// On startup a new client will ping existing clients to determine if the
		// connections are still connected
		redisClient.forceGetClient().on('message', async (channel, message) => {
			if (channel === REDIS_CHANNEL_PREFIX) {
				const { id, ping = false, pong = false } = JSON.parse(message);

				if (id === CLIENT && ping) {
					await redisClient.publish(`${REDIS_CHANNEL_PREFIX}`, {
						id,
						pong: true,
					});
				}

				if (id !== CLIENT && pong) {
					connectedClients.push(id);
				}
			}
		});

		const clients = await getClients();

		clients
			.filter((client) => client.id !== CLIENT)
			.map(async (client) => {
				await redisClient.publish(`${REDIS_CHANNEL_PREFIX}`, {
					id: client.id,
					ping: true,
				});
			});

		// Clean up any stale connections
		setTimeout(async () => {
			logger.info(`Connected clients: ${connectedClients}`);

			const disconnectedClients = clients.filter(
				(client) => !connectedClients.includes(client.id)
			);
			logger.info(`Disconnected clients: ${disconnectedClients}`);
			disconnectedClients.map(async (client) => {
				await redisClient.lRem(REDIS_CONFIG_KEY, 1, JSON.stringify(client));
			});

			await checkIfShouldPromote();
		}, 3000);
	};

	const promote = async () => {
		const clients = await getClients();
		const firstClient = clients?.[0];

		if (!firstClient) {
			throw new Error('Failed promoting a client: Unable to find client');
		}

		const payload = { ...firstClient, isWriting: true };

		await redisClient
			.forceGetClient()
			.lset(REDIS_CONFIG_KEY, 0, JSON.stringify(payload));

		await redisClient.publish(
			`${REDIS_CHANNEL_PREFIX}-${firstClient.id}`,
			payload
		);

		logger.alert(`Promoting new publishing client: ${firstClient.id}`);
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
		checkIfClientsConnected,
	};
};
