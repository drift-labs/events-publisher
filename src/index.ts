require('dotenv').config();

import { DriftClient, DriftEnv, Wallet } from '@drift-labs/sdk';
import { Connection, Keypair } from '@solana/web3.js';
import { ConfigurationService } from './services/configuration';
import { GrpcEventSubscriber } from './services/gprcSubscriber';

import { RedisClient, logger } from '@drift/common';

const driftEnv = (process.env.ENV || 'devnet') as DriftEnv;
const endpoint = process.env.GRPC_ENDPOINT;
if (!endpoint) {
	throw new Error('Missing GRPC_ENDPOINT');
}
const token = process.env.TOKEN;

export async function main() {
	const redisClient = new RedisClient({});
	await redisClient.connect();

	const driftClient = new DriftClient({
		env: driftEnv,
		connection: new Connection(endpoint!),
		wallet: new Wallet(new Keypair()),
	});

	const { subscribe } = GrpcEventSubscriber(
		driftClient,
		redisClient,
		logger,
		{
			programId: driftClient.program.programId.toString(),
			endpoint: endpoint!,
			token: token!,
		}
	);

	const { setupClient, shutdown, awaitPromotion } = ConfigurationService(
		redisClient,
		logger
	);

	const handleShutdown = async (message: string) => {
		logger.alert(message);
		await shutdown();
		process.exit();
	};

	try {
		await setupClient();
		await awaitPromotion({
			callback: async () => await subscribe(),
		});
	} catch (error) {
		console.log(error);
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
