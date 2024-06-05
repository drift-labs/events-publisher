import { RedisClient, Logger } from '@drift/common';
import { v4 as uuidv4 } from 'uuid';

const REDIS_CONFIG_KEY = 'events-publisher-config';
const CLIENT = uuidv4();
const FRESHNESS_TTL = 1500;

interface Client {
	id: string;
	freshness: number;
	isWriting?: boolean;
	isFailover?: boolean;
}

export const ConfigurationService = (
	redisClient: RedisClient,
	logger: Logger
) => {
	logger.info(`Starting up client: ${CLIENT}`);

	const setupClient = async () => {
		await redisClient.rPush(
			REDIS_CONFIG_KEY,
			JSON.stringify({ id: CLIENT, freshness: Date.now() })
		);
		setInterval(async () => {
			await updateFreshness();
			await checkConnectedClients();
			await checkIfShouldPromote();
			await checkIfMultipleWriteClients();
		}, 500);
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

	const awaitPromotion = async ({ callback }: { callback: Function}) => {
		const timer = setInterval(async () => {
			const { isWriting = false, isFailover = false } =
				(await getClient()) ?? {};
			if (isWriting) {
				logger.info(`Starting to write on client: ${CLIENT}`);
				callback();
				clearInterval(timer);
			}
			if (isFailover) {
				console.log('in here')
				throw new Error(`Failing over client: ${CLIENT}`);
			}
		}, 500);

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

	const checkConnectedClients = async () => {
		const clients = await getClients();
		const disconnectedClients = clients?.filter(
			(client) => (client?.freshness || 0) < Date.now() - FRESHNESS_TTL
		);
		disconnectedClients.map(async (client) => {
			logger.info(`Disconnected Client: ${client.id}`);
			await redisClient.lRem(REDIS_CONFIG_KEY, 1, JSON.stringify(client));
		});
	};

	const checkIfMultipleWriteClients = async () => {
		const clients = await getClients();
		const writingClients = clients.filter((client) => client.isWriting);
		if (writingClients.length > 1) {
			logger.alert('Duplicate publishing clients are running');
			if (writingClients[0].id === CLIENT) {
				throw new Error('Failing over client due to duplicate writers');
			}
		}
	};

	const updateFreshness = async () => {
		const clients = await getClients();
		const clientIndex = clients.findIndex((client) => client.id === CLIENT);
		const payload = { ...clients[clientIndex], freshness: Date.now() };
		await redisClient.lSet(
			REDIS_CONFIG_KEY,
			clientIndex,
			JSON.stringify(payload)
		);
	};

	const promote = async () => {
		const clients = await getClients();
		const firstClient = clients?.[0];
		if (!firstClient) {
			throw new Error('Failed promoting a client: No client exists');
		}

		const payload = { ...firstClient, isWriting: true };
		await redisClient.lSet(REDIS_CONFIG_KEY, 0, JSON.stringify(payload));

		logger.alert(`Promoting new publishing client: ${firstClient.id}`);
	};

	const getClients = async (): Promise<Client[]> => {
		const clients: Client[] = (
			await redisClient.lRange(REDIS_CONFIG_KEY, 0, -1)
		)?.map((client) => JSON.parse(client));
		return clients ?? [];
	};

	const getClient = async (): Promise<Client | undefined> => {
		const clients = await getClients();
		return clients.find((client) => client.id === CLIENT);
	};

	return {
		getClients,
		getClient,
		updateFreshness,
		setupClient,
		shutdown,
		awaitPromotion,
		promote,
		checkIfShouldPromote,
		checkConnectedClients,
		checkIfMultipleWriteClients,
	};
};
